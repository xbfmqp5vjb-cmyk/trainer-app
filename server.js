"use strict";

/**
 * Omgeving (zie env.example):
 * PORT — luisterpoort (Railway/Heroku zetten vaak PORT)
 * ANTHROPIC_API_KEY — verplicht
 * ANTHROPIC_MODEL_FALLBACK — optioneel tweede model bij aanhoudende 529/503/502 na retries
 * CORS_ALLOWED_ORIGINS — komma-gescheiden extra origins (zelfde host als Host-header is altijd ok)
 *
 * POST /api/generate-block — nieuw 4-wekenblok op basis van data uit de app (body bevat o.a. intake + vorig programma; zie buildGenerateBlockUserContent).
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const http = require("http");
const fs = require("fs").promises;

const PORT = parseInt(process.env.PORT || "3000", 10) || 3000;
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL_FALLBACK = (process.env.ANTHROPIC_MODEL_FALLBACK || "").trim();

const ANTHROPIC_RETRY_STATUSES = new Set([429, 502, 503, 529]);
const ANTHROPIC_MAX_ATTEMPTS = 5;

const corsExtraOrigins = new Set(
  (process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/** Verwijdert proxy-interne velden (o.a. _schemaIntake) — Anthropic weigert onbekende top-level keys. */
function anthropicRequestPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  return Object.fromEntries(
    Object.entries(payload).filter(function (entry) {
      return String(entry[0]).charAt(0) !== "_";
    })
  );
}

/** Anthropic geeft soms 529 Overloaded; korte pauzes en opnieuw proberen helpt vaak. */
async function callAnthropicMessages(apiKey, payload, options) {
  options = options || {};
  const maxAttempts = Math.max(1, Math.min(10, options.maxAttempts || ANTHROPIC_MAX_ATTEMPTS));
  const bodyStr = JSON.stringify(anthropicRequestPayload(payload));
  let lastStatus = 0;
  let lastText = "";
  let lastCt = "application/json";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ar = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION
      },
      body: bodyStr
    });

    lastStatus = ar.status;
    lastText = await ar.text();
    lastCt = ar.headers.get("content-type") || "application/json";

    const shouldRetry = ANTHROPIC_RETRY_STATUSES.has(ar.status);
    if (ar.ok || !shouldRetry || attempt === maxAttempts) {
      if (!ar.ok) {
        console.error(
          "[anthropic] HTTP %s (poging %s/%s)\n%s",
          ar.status,
          attempt,
          maxAttempts,
          lastText.slice(0, 500)
        );
      }
      return { status: lastStatus, text: lastText, contentType: lastCt };
    }

    let waitMs = Math.min(45000, 2000 * Math.pow(2, attempt - 1));
    const ra = ar.headers.get("retry-after");
    if (ra) {
      const sec = parseInt(String(ra).trim(), 10);
      if (!Number.isNaN(sec) && sec > 0) {
        waitMs = Math.min(90000, sec * 1000);
      }
    }

    console.warn(
      "[anthropic] %s — wacht %ss en probeer opnieuw (%s/%s)…",
      ar.status,
      Math.round(waitMs / 100) / 10,
      attempt + 1,
      maxAttempts
    );
    await sleep(waitMs);
  }

  return { status: lastStatus, text: lastText, contentType: lastCt };
}

function isAllowedOrigin(origin, rawHost) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return true;
    if (corsExtraOrigins.has(origin)) return true;
    if (rawHost) {
      const reqHost = String(rawHost).split(":")[0].toLowerCase();
      if (u.hostname.toLowerCase() === reqHost) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function applyCors(res, origin) {
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else if (!origin) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function collectRequestBody(req) {
  var body = "";
  for await (const chunk of req) {
    body += chunk;
  }
  return body;
}

var eliteSchemaPromptCache = null;

async function loadEliteSchemaPrompt() {
  if (eliteSchemaPromptCache != null) return eliteSchemaPromptCache;
  var elitePath = path.join(__dirname, "schema-generation-elite.txt");
  var elite = await fs.readFile(elitePath, "utf8");
  eliteSchemaPromptCache = String(elite).trim();
  return eliteSchemaPromptCache;
}

function stringifyBlockPayloadSection(title, data) {
  var head = String(title || "") + "\n";
  if (data == null || data === "") return head + "(geen data)\n";
  if (typeof data === "string") return head + data + "\n";
  try {
    return head + JSON.stringify(data, null, 2) + "\n";
  } catch (e) {
    return head + String(data) + "\n";
  }
}

/** Body van POST /api/generate-block: o.a. intakeProfile, vorigProgramma, trainingHistorie, vorigBlokNummer, model. */
function buildGenerateBlockUserContent(body) {
  body = body || {};
  var prevRaw = body.vorigBlokNummer != null ? body.vorigBlokNummer : body.vorig_blok != null ? body.vorig_blok : body.huidigBlokNummer;
  var prevN = parseInt(String(prevRaw != null ? prevRaw : "1"), 10);
  if (!Number.isFinite(prevN) || prevN < 1) prevN = 1;
  var nextBlok = prevN + 1;
  var intake =
    body.intakeProfile != null
      ? body.intakeProfile
      : body.intake != null
        ? body.intake
        : body.gebruikersprofiel != null
          ? body.gebruikersprofiel
          : null;
  var prog =
    body.vorigProgramma != null
      ? body.vorigProgramma
      : body.programVorigBlok != null
        ? body.programVorigBlok
        : body.programma_vorig_blok != null
          ? body.programma_vorig_blok
          : null;
  var hist =
    body.trainingHistorie != null
      ? body.trainingHistorie
      : body.trainingHistory != null
        ? body.trainingHistory
        : body.afrondingen != null
          ? body.afrondingen
          : null;
  var lines = [];
  lines.push(
    "OPDRACHT: genereer het VOLGENDE 4-weken trainingsschema (één volledig blok) als directe voortgang op het vorige blok."
  );
  lines.push(
    "Er is geen nieuwe intake-sessie: gebruik uitsluitend de hieronder meegestuurde profiel-, schema- en historische gegevens, plus de blok-naar-blok-regels uit je system prompt."
  );
  lines.push("");
  lines.push("UITVOER — strikt één geldig JSON-object (UTF-8), zelfde structuur als het intake-schema:");
  lines.push('- Root keys: "naam", "programma", "blok", "weken".');
  lines.push('- "blok": geheel getal; voor dit verzoek moet dit precies ' + nextBlok + " zijn (vorig blok was " + prevN + ").");
  lines.push('- "weken": precies 4 objecten, elk met "week" (1–4) en "dagen": precies 7 dagen ("dag": Maandag…Zondag, "trainingen": array).');
  lines.push(
    '- Per training: "titel", "duur" (minuten als integer), "gedaan": false, "warmup"/"training"/"cooldown": arrays van strings.'
  );
  lines.push("- Geen markdown, geen codeblokken (```), geen tekst vóór of na de JSON.");
  lines.push("");
  lines.push(stringifyBlockPayloadSection("=== GEBRUIKERSPROFIEL (intake / localStorage) ===", intake));
  if (intake && typeof intake === "object" && intake.sport_relatie != null && String(intake.sport_relatie).trim()) {
    var sr = String(intake.sport_relatie).trim();
    lines.push("");
    lines.push(
      "SPORT_RELATIE (" +
        sr +
        "): zelfde betekenis als bij eerste schema-generatie. Bij train_voor_sport: uitsluitend kracht- en conditioningswerk voor de fysieke eisen van de genoemde sport, geen sporttechniek-training."
    );
  }
  lines.push(stringifyBlockPayloadSection("=== PROGRAMMA + NOTITIES VORIG BLOK (localStorage programma) ===", prog));
  lines.push(stringifyBlockPayloadSection("=== TRAININGS- / AFRONDINGSHISTORIE VORIG BLOK ===", hist));
  var extra = body.extraContext != null ? body.extraContext : body.aanvullende_context;
  if (extra != null && String(extra).trim() !== "") {
    lines.push(stringifyBlockPayloadSection("=== EXTRA CONTEXT ===", extra));
  }
  return lines.join("\n");
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";

  const pathOnly = (req.url || "").split("?")[0];

  if (req.method === "GET" && (pathOnly === "/" || pathOnly === "/trainer.html")) {
    try {
      const htmlPath = path.join(__dirname, "trainer.html");
      const buf = await fs.readFile(htmlPath);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
      res.end(buf);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Kon trainer.html niet lezen.");
    }
    return;
  }

  if (req.method === "GET" && pathOnly === "/api/health") {
    applyCors(res, origin);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(JSON.stringify({ ok: true, service: "training-ai-proxy" }));
    return;
  }

  if (
    req.method === "OPTIONS" &&
    (pathOnly === "/api/generate" || pathOnly === "/api/generate-block")
  ) {
    if (origin && !isAllowedOrigin(origin, req.headers.host)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "CORS: origin niet toegestaan" } }));
      return;
    }
    applyCors(res, origin);
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathOnly !== "/api/generate" && pathOnly !== "/api/generate-block") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Not found" } }));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Not found" } }));
    return;
  }

  applyCors(res, origin);

  if (origin && !isAllowedOrigin(origin, req.headers.host)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "CORS: origin niet toegestaan" } }));
    return;
  }

  const rawKey = process.env.ANTHROPIC_API_KEY || "";
  const apiKey = rawKey.trim().replace(/^["']|["']$/g, "");
  if (!apiKey || apiKey === "JOUW_KEY") {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message:
            "Zet ANTHROPIC_API_KEY in .env (geen placeholder JOUW_KEY) en herstart de server."
        }
      })
    );
    return;
  }

  if (pathOnly === "/api/generate-block") {
    let bodyStr;
    try {
      bodyStr = await collectRequestBody(req);
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Body lezen mislukt" } }));
      return;
    }
    let clientBody;
    try {
      clientBody = JSON.parse(bodyStr || "{}");
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Ongeldige JSON body" } }));
      return;
    }
    let elitePrompt = "";
    try {
      elitePrompt = await loadEliteSchemaPrompt();
    } catch (e) {
      console.warn("[generate-block] elite prompt:", e && e.message);
    }
    if (!String(elitePrompt).trim()) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message:
              "Kon schema-generation-elite.txt niet lezen. Controleer of het bestand in de projectmap staat."
          }
        })
      );
      return;
    }
    const blockModel =
      clientBody &&
      typeof clientBody.model === "string" &&
      clientBody.model.trim()
        ? clientBody.model.trim()
        : (process.env.ANTHROPIC_MODEL || "").trim() || "claude-sonnet-4-20250514";
    const userContent = buildGenerateBlockUserContent(clientBody);
    const anthropicBlockPayload = {
      model: blockModel,
      max_tokens: 16384,
      system: String(elitePrompt).trim(),
      messages: [{ role: "user", content: userContent }]
    };
    try {
      let out = await callAnthropicMessages(apiKey, anthropicBlockPayload);
      const overload = new Set([429, 502, 503, 529]);
      if (
        MODEL_FALLBACK &&
        anthropicBlockPayload &&
        typeof anthropicBlockPayload.model === "string" &&
        anthropicBlockPayload.model !== MODEL_FALLBACK &&
        !out.ok &&
        overload.has(out.status)
      ) {
        console.warn("[anthropic] generate-block: probeer fallback-model:", MODEL_FALLBACK);
        const payload2 = Object.assign({}, anthropicBlockPayload, { model: MODEL_FALLBACK });
        out = await callAnthropicMessages(apiKey, payload2, { maxAttempts: 4 });
      }
      res.writeHead(out.status, { "Content-Type": out.contentType });
      res.end(out.text);
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: err.message || "Proxy naar Anthropic mislukt" }
        })
      );
    }
    return;
  }

  let body = "";
  try {
    body = await collectRequestBody(req);
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Body lezen mislukt" } }));
    return;
  }

  let payload;
  try {
    payload = JSON.parse(body || "{}");
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Ongeldige JSON body" } }));
    return;
  }

  var schemaIntake = false;
  if (payload && Object.prototype.hasOwnProperty.call(payload, "_schemaIntake")) {
    var flagVal = payload._schemaIntake;
    schemaIntake =
      flagVal === true ||
      flagVal === 1 ||
      (typeof flagVal === "string" &&
        /^(1|true|yes|on)$/i.test(String(flagVal).trim()));
    delete payload._schemaIntake;
  }
  if (schemaIntake) {
    try {
      const elite = await loadEliteSchemaPrompt();
      if (elite) payload.system = elite;
    } catch (e) {
      console.warn("[schema] schema-generation-elite.txt niet gelezen:", e && e.message);
    }
  }

  try {
    let out = await callAnthropicMessages(apiKey, payload);
    const overload = new Set([429, 502, 503, 529]);
    if (
      MODEL_FALLBACK &&
      payload &&
      typeof payload.model === "string" &&
      payload.model !== MODEL_FALLBACK &&
      !out.ok &&
      overload.has(out.status)
    ) {
      console.warn("[anthropic] probeer fallback-model:", MODEL_FALLBACK);
      const payload2 = Object.assign({}, payload, { model: MODEL_FALLBACK });
      out = await callAnthropicMessages(apiKey, payload2, { maxAttempts: 4 });
    }
    res.writeHead(out.status, { "Content-Type": out.contentType });
    res.end(out.text);
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: err.message || "Proxy naar Anthropic mislukt" }
      })
    );
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      "\nPoort %s is al in gebruik (EADDRINUSE).\n" +
        "Er draait al een node-server op deze poort — vaak een eerdere `npm start`.\n\n" +
        "Oplossing:\n" +
        "  • Zoek het oude terminalvenster en druk Ctrl+C, of\n" +
        "  • Beëindig het proces: kill $(lsof -t -iTCP:%s -sTCP:LISTEN)\n" +
        "  • Daarna opnieuw: npm start\n",
      PORT,
      PORT
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log("Server luistert op poort %s", PORT);
  console.log("POST %s", `http://localhost:${PORT}/api/generate`);
  console.log("POST %s", `http://localhost:${PORT}/api/generate-block`);
  console.log("GET  %s", `http://localhost:${PORT}/api/health`);
  console.log("App:  %s", `http://localhost:${PORT}/`);
  if (MODEL_FALLBACK) console.log("Fallback-model bij overload: %s", MODEL_FALLBACK);
});
