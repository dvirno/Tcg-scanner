// Server del centralino: riceve le chiamate da Twilio e le collega a Claude.
//
//   Chiamata  →  Twilio  →  POST /voice (TwiML)  →  ConversationRelay
//   ConversationRelay  ⇄  WebSocket /ws  ⇄  Claude (testo)
//   Trasferimento/chiusura  →  POST /handoff (TwiML con <Dial> o <Hangup>)
import "dotenv/config";
import express from "express";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import twilio from "twilio";
import { WebSocketServer } from "ws";
import { CallSession, loadConfig } from "./agent.js";

const PORT = Number(process.env.PORT || 3000);
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const DATA_DIR = process.env.DATA_DIR || path.resolve(import.meta.dirname, "../data");
const LANGUAGE = process.env.LANGUAGE || "it-IT";

const app = express();
app.use(express.urlencoded({ extended: false }));

function publicUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  return `https://${req.headers.host}`;
}

// Verifica che le richieste arrivino davvero da Twilio (se è impostato il token).
const twilioOnly = (req, res, next) => {
  if (!AUTH_TOKEN) return next();
  const ok = twilio.validateRequest(
    AUTH_TOKEN,
    req.headers["x-twilio-signature"] || "",
    publicUrl(req) + req.originalUrl,
    req.body || {},
  );
  if (!ok) return res.status(403).send("Firma Twilio non valida");
  next();
};

const escapeXml = (s) =>
  String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);

// 1) Twilio chiama questo URL quando arriva una telefonata.
app.post("/voice", twilioOnly, (req, res) => {
  const config = loadConfig();
  const base = publicUrl(req);
  const wsUrl = base.replace(/^http/, "ws") + "/ws";
  const tts = [
    process.env.TTS_PROVIDER ? `ttsProvider="${escapeXml(process.env.TTS_PROVIDER)}"` : "",
    process.env.TTS_VOICE ? `voice="${escapeXml(process.env.TTS_VOICE)}"` : "",
  ].join(" ");

  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect action="${base}/handoff">
    <ConversationRelay url="${wsUrl}" language="${LANGUAGE}" ${tts}
      welcomeGreeting="${escapeXml(config.saluto)}" interruptible="true" />
  </Connect>
</Response>`);
});

// 2) Quando la conversazione AI finisce, Twilio chiede cosa fare: trasferire o riagganciare.
app.post("/handoff", twilioOnly, (req, res) => {
  let data = {};
  try {
    data = JSON.parse(req.body.HandoffData || "{}");
  } catch {}

  let twiml;
  if (data.action === "transfer" && data.number) {
    const say = data.announce
      ? `<Say language="${LANGUAGE}">${escapeXml(data.announce)}</Say>`
      : "";
    twiml = `${say}<Dial timeout="25">${escapeXml(data.number)}</Dial>
  <Say language="${LANGUAGE}">Mi dispiace, al momento nessuno è disponibile. La preghiamo di richiamare più tardi. Arrivederci.</Say>`;
  } else if (data.action === "error") {
    twiml = `<Say language="${LANGUAGE}">Ci scusiamo, si è verificato un problema tecnico. La preghiamo di richiamare tra qualche minuto.</Say>`;
  } else {
    twiml = "";
  }
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  ${twiml}\n  <Hangup/>\n</Response>`);
});

app.get("/", (_req, res) => res.send("Centralino AI attivo ✅"));

// Salvataggio dei messaggi lasciati dai clienti.
async function saveMessage(record) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.appendFile(path.join(DATA_DIR, "messaggi.jsonl"), JSON.stringify(record) + "\n");
  console.log("📩 Nuovo messaggio:", record);
  if (process.env.MESSAGE_WEBHOOK_URL) {
    // Es. un webhook Slack, Zapier, Make o n8n per ricevere il messaggio via email/chat.
    fetch(process.env.MESSAGE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `📞 Messaggio per ${record.reparto}${record.urgente ? " (URGENTE)" : ""}: ${record.nome} (${record.telefono}) — ${record.messaggio}`,
        ...record,
      }),
    }).catch((err) => console.error("Invio webhook fallito:", err.message));
  }
}

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/ws")) return socket.destroy();
  if (AUTH_TOKEN) {
    const base = process.env.PUBLIC_URL?.replace(/\/$/, "") || `https://${req.headers.host}`;
    const url = base.replace(/^http/, "ws") + req.url;
    if (!twilio.validateRequest(AUTH_TOKEN, req.headers["x-twilio-signature"] || "", url, {})) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      return socket.destroy();
    }
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// Tempo approssimativo per pronunciare un testo, così non chiudiamo prima che finisca di parlare.
const speakingTimeMs = (text) => Math.min(10000, 600 + text.length * 65);

// 3) Una connessione WebSocket = una telefonata.
wss.on("connection", (ws) => {
  let session = null;
  let queue = Promise.resolve();
  let ended = false;

  const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));
  const end = (handoff) => {
    if (ended) return;
    ended = true;
    send({ type: "end", handoffData: JSON.stringify(handoff) });
  };

  const handlePrompt = async (text) => {
    let spoken = "";
    try {
      const result = await session.handleUserTurn(text, (token) => {
        spoken += token;
        send({ type: "text", token, last: false });
      });
      send({ type: "text", token: "", last: true });

      if (result.action === "transfer") {
        console.log(`↪️  ${session.callSid}: trasferimento a ${result.department} (${result.reason})`);
        await new Promise((r) => setTimeout(r, speakingTimeMs(spoken)));
        end({
          action: "transfer",
          number: result.number,
          announce: spoken.trim() ? "" : `La metto in contatto con ${result.department}, attenda in linea.`,
        });
      } else if (result.action === "hangup") {
        await new Promise((r) => setTimeout(r, speakingTimeMs(spoken)));
        end({ action: "hangup" });
      }
    } catch (err) {
      console.error("Errore durante la risposta:", err);
      end({ action: "error" });
    }
  };

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case "setup":
        session = new CallSession({ caller: msg.from, callSid: msg.callSid, onMessage: saveMessage });
        console.log(`📞 Nuova chiamata ${msg.callSid} da ${msg.from}`);
        break;
      case "prompt":
        if (!session || ended || !msg.voicePrompt?.trim()) break;
        console.log(`🗣️  Cliente: ${msg.voicePrompt}`);
        // Le frasi vengono elaborate una alla volta, nell'ordine in cui arrivano.
        queue = queue.then(() => (ended ? undefined : handlePrompt(msg.voicePrompt)));
        break;
      case "interrupt":
        session?.interrupt(msg.utteranceUntilInterrupt);
        break;
      case "error":
        console.error("Errore ConversationRelay:", msg.description);
        break;
    }
  });

  ws.on("close", () => {
    ended = true;
    session?.interrupt();
    if (session) console.log(`☎️  Chiamata ${session.callSid} terminata`);
  });
});

server.listen(PORT, () => {
  console.log(`Centralino AI in ascolto sulla porta ${PORT}`);
  if (!AUTH_TOKEN) console.warn("⚠️  TWILIO_AUTH_TOKEN non impostato: le richieste non vengono verificate.");
});
