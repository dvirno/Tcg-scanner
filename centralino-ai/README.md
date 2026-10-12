# Centralino AI 📞

Un centralino telefonico con intelligenza artificiale: risponde al tuo numero, parla in italiano,
risponde alle domande sulla tua attività, **passa la chiamata al reparto giusto** e, fuori orario,
**prende i messaggi** dei clienti.

- **Twilio** fornisce il numero di telefono, il riconoscimento vocale e la sintesi vocale (ConversationRelay).
- **Claude** è il "cervello": capisce cosa vuole il cliente e decide cosa fare.

```
Cliente ──► Numero Twilio ──► /voice ──► ConversationRelay ⇄ /ws ⇄ Claude
                                                │
                     trasferimento/chiusura ──► /handoff ──► <Dial> reparto
```

## 1. Cosa ti serve

1. **Node.js 20+**
2. Un account **Twilio** con un numero di telefono con funzione voce
   (Console → Phone Numbers → Buy a number). Per i numeri italiani Twilio chiede un documento e un indirizzo
   (*Regulatory Bundle*).
3. Una **chiave API Anthropic**, da https://platform.claude.com
4. Un indirizzo **pubblico HTTPS** dove far girare il server: per le prove va bene [ngrok](https://ngrok.com);
   in produzione un servizio come Render, Railway, Fly.io o un VPS.

## 2. Configurazione

```bash
cd centralino-ai
npm install
cp .env.example .env      # poi compila ANTHROPIC_API_KEY, TWILIO_AUTH_TOKEN, PUBLIC_URL
```

Modifica **`config.json`** con i dati della tua attività:

| Campo | Cosa contiene |
|---|---|
| `azienda`, `nomeAssistente`, `saluto` | nome dell'azienda e frase con cui risponde il centralino |
| `orari` | orari di apertura: fuori orario non trasferisce le chiamate e prende un messaggio |
| `reparti` | ogni reparto con descrizione (serve all'AI per scegliere) e numero a cui inoltrare, in formato `+39...` |
| `informazioni` | indirizzo, FAQ, prezzi... tutto ciò che il centralino può dire ai clienti |
| `istruzioniExtra` | regole aggiuntive in linguaggio naturale |

## 3. Prova senza telefono

```bash
npm run test-chat
```
Scrivi come se fossi un cliente e controlli le risposte, i trasferimenti e i messaggi.

## 4. Avvio e collegamento del numero

```bash
npm start                  # avvia il server sulla porta 3000
ngrok http 3000            # (solo per le prove) ti dà un URL https://xxxx.ngrok.app
```

Metti l'URL pubblico in `PUBLIC_URL` nel file `.env` e riavvia. Poi, nella **Console Twilio**:

1. **Phone Numbers → Manage → Active numbers** → clicca sul tuo numero
2. In **Voice Configuration**, alla voce *A call comes in*, scegli **Webhook**
3. URL: `https://TUO-INDIRIZZO/voice` — metodo **HTTP POST**
4. Salva e chiama il numero. 🎉

> **Vuoi tenere il tuo numero attuale?** Hai due possibilità: imposta sul tuo operatore un
> **inoltro di chiamata** verso il numero Twilio (sempre, oppure solo se occupato o se non rispondi),
> oppure fai la **portabilità** del numero su Twilio.

## 5. Messaggi dei clienti

I messaggi lasciati vengono salvati in `data/messaggi.jsonl`, un messaggio per riga.
Se imposti `MESSAGE_WEBHOOK_URL` vengono anche inviati in tempo reale a quell'indirizzo: per esempio un
*Incoming Webhook* di Slack, oppure Zapier, Make o n8n per riceverli via email, WhatsApp o Google Sheets.

## Personalizzazione

- **Voce:** imposta `TTS_PROVIDER` e `TTS_VOICE` (es. ElevenLabs, Google, Amazon) tra le voci italiane supportate
  da [ConversationRelay](https://www.twilio.com/docs/voice/conversationrelay).
- **Velocità o ragionamento:** `CLAUDE_EFFORT=low` (default) dà risposte più rapide;
  `medium` ragiona di più ma risponde con più ritardo.
- **Comportamento:** il prompt di sistema è in `src/agent.js` (`buildSystemPrompt`), mentre gli strumenti
  dell'AI (trasferisci, lascia messaggio, termina) sono nell'array `tools`.

## Costi indicativi

- **Twilio:** canone del numero, più i minuti di chiamata in entrata e ConversationRelay, al minuto.
  Quando trasferisci una chiamata paghi anche la chiamata in uscita verso il reparto.
  Prezzi aggiornati: https://www.twilio.com/voice/pricing
- **Claude:** si paga per token, in genere pochi centesimi per chiamata.

## Note legali (GDPR)

Il centralino elabora la voce e i dati dei chiamanti. Informa i clienti, per esempio nel saluto
("…sono l'assistente virtuale…"), aggiorna l'informativa privacy e valuta per quanto tempo conservare
`data/messaggi.jsonl`.
