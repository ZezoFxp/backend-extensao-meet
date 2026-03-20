/**
 * server.js — Meet Scheduler Backend
 * ─────────────────────────────────────────────────────────────────────────
 * Recebe requests da extensão Chrome e agenda reuniões usando a conta host.
 * O usuário final nunca autentica — só informa título, horário e e-mails.
 * ─────────────────────────────────────────────────────────────────────────
 */

require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

// ── CORS ──────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Permite requests sem origin (ex: curl, testes locais) ou origins na whitelist
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      cb(null, true);
    } else {
      cb(new Error(`CORS bloqueado para origin: ${origin}`));
    }
  }
}));

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.api_key;
  if (!process.env.EXTENSION_API_KEY) {
    console.warn("⚠️  EXTENSION_API_KEY não definida — endpoint desprotegido!");
    return next();
  }
  if (key !== process.env.EXTENSION_API_KEY) {
    return res.status(401).json({ error: "Chave de API inválida." });
  }
  next();
}

// ── GOOGLE OAUTH CLIENT (conta host) ─────────────────────────────────────
function getOAuthClient() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return client;
}

// ── VALIDAÇÕES ────────────────────────────────────────────────────────────
function validateEmails(list) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return list.filter(e => re.test(e.trim()));
}

function validateDatetime(dt) {
  return !isNaN(Date.parse(dt));
}

// ─────────────────────────────────────────────────────────────────────────
// ROTAS
// ─────────────────────────────────────────────────────────────────────────

// Health check (sem auth)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", host: process.env.HOST_EMAIL || "não configurado" });
});

// ── POST /schedule ────────────────────────────────────────────────────────
// Cria uma reunião Google Meet como conta host.
//
// Body esperado:
// {
//   "title":         "Nome da reunião",          // obrigatório
//   "startDateTime": "2025-04-10T14:00:00",      // obrigatório, ISO 8601 local
//   "endDateTime":   "2025-04-10T15:00:00",      // obrigatório
//   "timeZone":      "America/Sao_Paulo",        // opcional (default: America/Sao_Paulo)
//   "attendees":     ["a@email.com", "b@email.com"], // obrigatório, mín. 1
//   "description":   "Pauta opcional",           // opcional
//   "sendEmails":    true                         // opcional (default: true)
// }
app.post("/schedule", requireApiKey, async (req, res) => {
  const {
    title,
    startDateTime,
    endDateTime,
    timeZone      = "America/Sao_Paulo",
    attendees     = [],
    description   = "",
    sendEmails    = true
  } = req.body;

  // ── Validação básica
  const errors = [];
  if (!title?.trim())               errors.push("title é obrigatório.");
  if (!validateDatetime(startDateTime)) errors.push("startDateTime inválido.");
  if (!validateDatetime(endDateTime))   errors.push("endDateTime inválido.");
  if (!Array.isArray(attendees) || attendees.length === 0)
    errors.push("Informe ao menos um e-mail em attendees.");

  if (errors.length) return res.status(400).json({ error: errors.join(" ") });

  const start = new Date(startDateTime);
  const end   = new Date(endDateTime);
  if (start >= end) return res.status(400).json({ error: "endDateTime deve ser após startDateTime." });

  const validEmails = validateEmails(attendees);
  if (validEmails.length === 0)
    return res.status(400).json({ error: "Nenhum e-mail válido em attendees." });

  // ── Chama Google Calendar API
  try {
    const auth     = getOAuthClient();
    const calendar = google.calendar({ version: "v3", auth });

    const event = {
      summary:     title.trim(),
      description: description.trim(),
      start: { dateTime: startDateTime, timeZone },
      end:   { dateTime: endDateTime,   timeZone },
      attendees: validEmails.map(email => ({ email: email.trim() })),
      conferenceData: {
        createRequest: {
          requestId: `ms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          conferenceSolutionKey: { type: "hangoutsMeet" }
        }
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: "email", minutes: 60 },
          { method: "popup", minutes: 10 }
        ]
      },
      // Garante que o host não apareça como convidado duplicado
      organizer: { email: process.env.HOST_EMAIL }
    };

    const response = await calendar.events.insert({
      calendarId:            "primary",
      conferenceDataVersion: 1,
      sendUpdates:           sendEmails ? "all" : "none",
      resource:              event
    });

    const created  = response.data;
    const meetLink = created.conferenceData?.entryPoints
      ?.find(ep => ep.entryPointType === "video")?.uri || null;

    console.log(`[${new Date().toISOString()}] Reunião criada: "${title}" | Meet: ${meetLink}`);

    return res.status(201).json({
      success:   true,
      eventId:   created.id,
      htmlLink:  created.htmlLink,
      meetLink,
      title:     created.summary,
      start:     created.start,
      end:       created.end,
      attendees: created.attendees?.map(a => a.email) || []
    });

  } catch (err) {
    console.error("[schedule] Erro Google API:", err.message);
    const status = err.code === 401 ? 502 : 500;
    return res.status(status).json({
      error:   "Erro ao criar reunião no Google Calendar.",
      details: err.message
    });
  }
});

// ── GET /upcoming ─────────────────────────────────────────────────────────
// Lista próximas reuniões da conta host (para debug / painel admin).
app.get("/upcoming", requireApiKey, async (req, res) => {
  const maxResults = Math.min(Number(req.query.max) || 10, 50);
  try {
    const auth     = getOAuthClient();
    const calendar = google.calendar({ version: "v3", auth });

    const response = await calendar.events.list({
      calendarId:   "primary",
      timeMin:      new Date().toISOString(),
      maxResults,
      singleEvents: true,
      orderBy:      "startTime"
    });

    const items = (response.data.items || []).map(e => ({
      id:       e.id,
      title:    e.summary,
      start:    e.start,
      end:      e.end,
      meetLink: e.conferenceData?.entryPoints?.find(ep => ep.entryPointType === "video")?.uri || null,
      htmlLink: e.htmlLink,
      attendees: (e.attendees || []).map(a => a.email)
    }));

    return res.json({ success: true, count: items.length, events: items });
  } catch (err) {
    console.error("[upcoming] Erro:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── DELETE /event/:id ─────────────────────────────────────────────────────
// Cancela uma reunião pelo eventId.
app.delete("/event/:id", requireApiKey, async (req, res) => {
  const { id } = req.params;
  const sendEmails = req.query.notify !== "false";
  try {
    const auth     = getOAuthClient();
    const calendar = google.calendar({ version: "v3", auth });

    await calendar.events.delete({
      calendarId:  "primary",
      eventId:     id,
      sendUpdates: sendEmails ? "all" : "none"
    });

    console.log(`[${new Date().toISOString()}] Evento deletado: ${id}`);
    return res.json({ success: true });
  } catch (err) {
    console.error("[delete] Erro:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀  Meet Scheduler Backend rodando na porta ${PORT}`);
  console.log(`    Host: ${process.env.HOST_EMAIL || "⚠️  HOST_EMAIL não definido"}`);
  console.log(`    API Key: ${process.env.EXTENSION_API_KEY ? "✅ configurada" : "⚠️  NÃO configurada"}\n`);
});
