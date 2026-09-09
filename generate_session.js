// Script de régénération d'une nouvelle SESSION_STRING Telegram propre
// Exécution : node generate_session.js
import readline from "readline";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import dotenv from "dotenv";

dotenv.config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

async function main() {
  console.log("=================================================");
  console.log("   Générateur de SESSION_STRING Telegram MTProto  ");
  console.log("=================================================\n");

  const apiIdStr = process.env.API_ID || (await ask("Entrez votre API_ID Telegram : "));
  const apiHash = process.env.API_HASH || (await ask("Entrez votre API_HASH Telegram : "));

  const apiId = parseInt(apiIdStr.trim(), 10);
  if (!apiId || !apiHash.trim()) {
    console.error("Erreur : API_ID et API_HASH sont obligatoires.");
    process.exit(1);
  }

  console.log("\nInitialisation d'une session vierge...");
  const stringSession = new StringSession("");
  const client = new TelegramClient(stringSession, apiId, apiHash.trim(), {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await ask("Numéro de téléphone international (ex: +33612345678) : "),
    password: async () => await ask("Mot de passe 2FA (si activé, sinon Entrée) : "),
    phoneCode: async () => await ask("Code reçu sur Telegram : "),
    onError: (err) => console.error("Erreur lors de la connexion :", err),
  });

  const sessionSaved = client.session.save();

  console.log("\n=================================================");
  console.log("✅ VOTRE NOUVELLE SESSION_STRING A ÉTÉ GÉNÉRÉE !");
  console.log("=================================================\n");
  console.log(sessionSaved);
  console.log("\nCopiez cette valeur dans vos variables d'environnement Render (SESSION_STRING).");

  await client.disconnect();
  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Erreur fatale :", err);
  rl.close();
  process.exit(1);
});
