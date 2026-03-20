/**
 * get-refresh-token.js
 * ─────────────────────────────────────────────────────────────────────────
 * Script ONE-TIME para obter o refresh_token da conta host.
 * 
 * Execute UMA VEZ:
 *   node get-refresh-token.js
 * 
 * Depois copie o refresh_token para o .env e nunca mais execute isso.
 * ─────────────────────────────────────────────────────────────────────────
 */

require("dotenv").config();
const { google } = require("googleapis");
const http       = require("http");
const url        = require("url");

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = "http://localhost:4242/oauth2callback";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("\n❌  Defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no .env antes de rodar.\n");
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type:  "offline",
  prompt:       "consent",           // força retornar refresh_token sempre
  scope: [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/userinfo.email"
  ]
});

console.log("\n════════════════════════════════════════════════════");
console.log("  Meet Scheduler — Gerador de Refresh Token");
console.log("════════════════════════════════════════════════════");
console.log("\n1. Abra a URL abaixo NO NAVEGADOR, com a conta HOST:\n");
console.log("   " + authUrl);
console.log("\n2. Autorize o acesso ao Google Calendar.");
console.log("3. Você será redirecionado para localhost — aguarde...\n");

// Servidor temporário para capturar o callback
const server = http.createServer(async (req, res) => {
  const qs   = url.parse(req.url, true).query;
  const code = qs.code;
  if (!code) return;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end("<h2>✅ Autorizado! Volte ao terminal e copie o refresh_token.</h2>");

  try {
    const { tokens } = await oauth2Client.getToken(code);
    console.log("════════════════════════════════════════════════════");
    console.log("  ✅  SUCESSO! Adicione isso ao seu .env:");
    console.log("════════════════════════════════════════════════════\n");
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log(`\n  (access_token atual: ${tokens.access_token?.slice(0,30)}...)`);
    console.log("\n⚠️  Guarde o refresh_token em segurança — não exponha no Git!\n");
  } catch (err) {
    console.error("❌  Erro ao trocar code por token:", err.message);
  }

  server.close();
});

server.listen(4242, () => {
  // servidor já logou a URL acima
});
