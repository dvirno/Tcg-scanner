// Il "cervello" del centralino: una conversazione con Claude per ogni chiamata.
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
// Al telefono conta la velocità di risposta: effort basso di default.
const EFFORT = process.env.CLAUDE_EFFORT || "low";

const client = new Anthropic();

export function loadConfig() {
  const file = process.env.CONFIG_FILE || path.resolve(import.meta.dirname, "../config.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function buildSystemPrompt(config, caller) {
  const now = new Date().toLocaleString("it-IT", {
    timeZone: config.fusoOrario || "Europe/Rome",
    dateStyle: "full",
    timeStyle: "short",
  });
  const orari = Object.entries(config.orari || {})
    .map(([giorno, ore]) => `- ${giorno}: ${ore}`)
    .join("\n");
  const reparti = config.reparti
    .map((r) => `- id "${r.id}": ${r.nome} — ${r.descrizione}`)
    .join("\n");
  const info = (config.informazioni || []).map((i) => `- ${i}`).join("\n");

  return `Sei ${config.nomeAssistente}, la centralinista virtuale di ${config.azienda}. Rispondi al telefono ai clienti che chiamano.

Stai parlando A VOCE: il tuo testo viene letto da una sintesi vocale.
- Frasi brevi e naturali, una o due alla volta. Niente elenchi, emoji, markdown, link o simboli.
- Scrivi i numeri come si pronunciano quando serve chiarezza (es. "le nove e trenta").
- Dai del "lei" al cliente, con tono cordiale e professionale.
- Fai una domanda alla volta e conferma i dati importanti (nome, numero di telefono) ripetendoli.

Cosa puoi fare:
1. Rispondere alle domande usando solo le informazioni qui sotto. Se non sai qualcosa, non inventare: proponi di lasciare un messaggio o di passare la chiamata al reparto giusto.
2. Passare la chiamata a un reparto con lo strumento trasferisci_chiamata, solo durante l'orario di apertura. Prima di trasferire, avvisa il cliente in una frase breve.
3. Fuori orario, o se il cliente preferisce, prendere un messaggio con lo strumento lascia_messaggio (servono almeno nome, numero di richiamata e motivo).
4. Quando la conversazione è conclusa e il cliente ha salutato, saluta e usa termina_chiamata.

Data e ora attuali: ${now}.
Numero del chiamante: ${caller || "sconosciuto"} (puoi proporlo come numero di richiamata, chiedendo conferma).

Orari di apertura:
${orari}

Reparti:
${reparti}

Informazioni utili:
${info}

${config.istruzioniExtra || ""}`.trim();
}

const tools = [
  {
    name: "trasferisci_chiamata",
    description:
      "Trasferisce la chiamata in corso al reparto indicato. Da usare solo in orario di apertura e dopo aver avvisato il cliente. La conversazione con te termina.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        reparto: { type: "string", description: "id del reparto" },
        motivo: { type: "string", description: "breve riassunto della richiesta del cliente" },
      },
      required: ["reparto", "motivo"],
      additionalProperties: false,
    },
  },
  {
    name: "lascia_messaggio",
    description:
      "Registra un messaggio per un reparto, che richiamerà il cliente. Usalo dopo aver raccolto e confermato nome, numero e motivo.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        reparto: { type: "string", description: "id del reparto destinatario" },
        nome: { type: "string" },
        telefono: { type: "string", description: "numero di richiamata" },
        messaggio: { type: "string", description: "motivo della chiamata, con i dettagli utili" },
        urgente: { type: "boolean" },
      },
      required: ["reparto", "nome", "telefono", "messaggio", "urgente"],
      additionalProperties: false,
    },
  },
  {
    name: "termina_chiamata",
    description: "Chiude la telefonata. Usalo solo dopo aver salutato il cliente.",
    strict: true,
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];

export class CallSession {
  /**
   * @param {object} opts
   * @param {string} [opts.caller] numero del chiamante
   * @param {string} [opts.callSid]
   * @param {(m: object) => Promise<void> | void} [opts.onMessage] salvataggio dei messaggi
   */
  constructor({ caller, callSid, onMessage } = {}) {
    this.config = loadConfig();
    this.caller = caller;
    this.callSid = callSid;
    this.onMessage = onMessage;
    this.system = buildSystemPrompt(this.config, caller);
    /** @type {Anthropic.Beta.BetaMessageParam[]} */
    this.messages = [];
    this.currentStream = null;
  }

  get greeting() {
    return this.config.saluto;
  }

  /**
   * Elabora una frase del cliente.
   * @param {string} text quello che ha detto il cliente
   * @param {(token: string) => void} onToken riceve il testo da leggere man mano che arriva
   * @returns {Promise<{action: "continue"} | {action: "transfer", number: string, department: string, reason: string} | {action: "hangup"}>}
   */
  async handleUserTurn(text, onToken) {
    // La prima battuta dell'assistente (il saluto) la legge Twilio: la mettiamo nel contesto.
    if (this.messages.length === 0) {
      text = `[Hai già detto al cliente: "${this.greeting}"]\n${text}`;
    }
    this.messages.push({ role: "user", content: text });

    while (true) {
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 4096,
        system: this.system,
        tools,
        messages: this.messages,
        output_config: { effort: EFFORT },
        // Se il modello declina la richiesta, l'API riprova automaticamente su un modello di riserva.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      this.currentStream = stream;
      stream.on("text", (delta) => onToken(delta));

      let response;
      try {
        response = await stream.finalMessage();
      } catch (err) {
        if (stream.aborted) return { action: "continue" }; // interrotto dal cliente
        throw err;
      } finally {
        this.currentStream = null;
      }

      this.messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason === "refusal") {
        onToken("Mi scusi, su questo non posso aiutarla. Posso fare altro per lei?");
        return { action: "continue" };
      }
      if (response.stop_reason !== "tool_use") return { action: "continue" };

      const toolUses = response.content.filter((b) => b.type === "tool_use");
      const results = [];
      let outcome = null;
      for (const tu of toolUses) {
        const { result, action } = await this.runTool(tu.name, tu.input);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: result.text, is_error: result.error || undefined });
        if (action) outcome = action;
      }
      this.messages.push({ role: "user", content: results });
      if (outcome) return outcome;
    }
  }

  async runTool(name, input) {
    if (name === "trasferisci_chiamata") {
      const rep = this.config.reparti.find((r) => r.id === input.reparto);
      if (!rep) {
        return { result: { text: `Reparto "${input.reparto}" inesistente.`, error: true } };
      }
      return {
        result: { text: `Trasferimento a ${rep.nome} avviato.` },
        action: { action: "transfer", number: rep.telefono, department: rep.nome, reason: input.motivo },
      };
    }
    if (name === "lascia_messaggio") {
      const record = {
        data: new Date().toISOString(),
        callSid: this.callSid,
        chiamante: this.caller,
        ...input,
      };
      await this.onMessage?.(record);
      return { result: { text: "Messaggio registrato correttamente." } };
    }
    if (name === "termina_chiamata") {
      return { result: { text: "Chiamata chiusa." }, action: { action: "hangup" } };
    }
    return { result: { text: `Strumento sconosciuto: ${name}`, error: true } };
  }

  /** Il cliente ha parlato sopra l'assistente: fermiamo la risposta in corso. */
  interrupt(heardSoFar) {
    if (this.currentStream) {
      this.currentStream.abort();
      this.messages.push({
        role: "assistant",
        content: heardSoFar ? `${heardSoFar}… [interrotto dal cliente]` : "[interrotto dal cliente]",
      });
    }
  }
}
