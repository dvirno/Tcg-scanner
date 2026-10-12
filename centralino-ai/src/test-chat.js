// Prova il centralino scrivendo dal terminale, senza telefono né Twilio.
//   npm run test-chat
import "dotenv/config";
import readline from "node:readline/promises";
import { CallSession } from "./agent.js";

const session = new CallSession({
  caller: "+393331234567",
  callSid: "TEST",
  onMessage: (m) => console.log("\n📩 [messaggio salvato]", m),
});
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log(`🤖 ${session.greeting}`);
while (true) {
  const text = await rl.question("\n🗣️  Tu: ");
  if (!text.trim()) continue;
  process.stdout.write("🤖 ");
  const result = await session.handleUserTurn(text, (t) => process.stdout.write(t));
  console.log();
  if (result.action === "transfer") {
    console.log(`↪️  [trasferimento a ${result.department} — ${result.number}]`);
    break;
  }
  if (result.action === "hangup") {
    console.log("☎️  [chiamata terminata]");
    break;
  }
}
rl.close();
