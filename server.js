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

var schemaGenerationPromptCache = null;

/** Lang system prompt voor intake-schema + generate-block; geladen uit schema-generation-elite-v3.txt */
async function loadSchemaGenerationPrompt() {
  if (schemaGenerationPromptCache != null) return schemaGenerationPromptCache;
  var promptPath = path.join(__dirname, "schema-generation-elite-v3.txt");
  var raw = await fs.readFile(promptPath, "utf8");
  schemaGenerationPromptCache = String(raw).trim();
  return schemaGenerationPromptCache;
}

/** Anthropic prompt caching: groot system prompt als cacheable text block. */
function systemPromptWithEphemeralCache(systemText) {
  var t = String(systemText || "").trim();
  if (!t) return t;
  return [
    {
      type: "text",
      text: t,
      cache_control: { type: "ephemeral" }
    }
  ];
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

/** Maandstring (Jan, Feb, mrt, 3, …) → 0–11 of null. */
function monthStringToIndex(maand) {
  if (maand == null || maand === "") return null;
  var s0 = String(maand).trim();
  if (!s0) return null;
  var n = parseInt(s0, 10);
  if (Number.isFinite(n) && n >= 1 && n <= 12) return n - 1;
  var s = s0.toLowerCase().replace(/\.$/, "");
  var map = {
    jan: 0,
    januari: 0,
    january: 0,
    feb: 1,
    februari: 1,
    february: 1,
    mrt: 2,
    mar: 2,
    maart: 2,
    march: 2,
    apr: 3,
    april: 3,
    mei: 4,
    may: 4,
    jun: 5,
    juni: 5,
    june: 5,
    jul: 6,
    juli: 6,
    july: 6,
    aug: 7,
    augustus: 7,
    august: 7,
    sep: 8,
    sept: 8,
    september: 8,
    okt: 9,
    oct: 9,
    oktober: 9,
    october: 9,
    nov: 10,
    november: 10,
    dec: 11,
    december: 11
  };
  if (map.hasOwnProperty(s)) return map[s];
  var three = s.slice(0, 3);
  if (map.hasOwnProperty(three)) return map[three];
  return null;
}

/** Leeftijd in jaren op basis van dag, maandlabel/-nummer en jaar. */
function calculateLeeftijd(dag, maand, jaar) {
  var d = parseInt(String(dag != null ? dag : "").trim(), 10);
  var y = parseInt(String(jaar != null ? jaar : "").trim(), 10);
  var mo = monthStringToIndex(maand);
  if (!Number.isFinite(d) || !Number.isFinite(y) || mo == null) return "";
  var birth = new Date(y, mo, d);
  if (isNaN(birth.getTime())) return "";
  var today = new Date();
  var age = today.getFullYear() - birth.getFullYear();
  var md = today.getMonth() - birth.getMonth();
  if (md < 0 || (md === 0 && today.getDate() < birth.getDate())) age--;
  return String(age);
}

function getHoofddoelenArrayFromIntake(intake) {
  if (!intake || typeof intake !== "object") return [];
  if (Array.isArray(intake.hoofddoelen)) return intake.hoofddoelen;
  if (typeof intake.hoofddoelen === "string" && String(intake.hoofddoelen).trim()) {
    try {
      var hj = JSON.parse(intake.hoofddoelen);
      if (Array.isArray(hj)) return hj;
    } catch (e0) {
      /* ignore */
    }
  }
  if (Array.isArray(intake.primair_doel)) return intake.primair_doel;
  return [];
}

/** hoofddoelen: array [{ doel, context }] → string; anders direct teruggeven. */
function parsePrimairDoel(hoofddoelen) {
  if (hoofddoelen == null) return "";
  if (typeof hoofddoelen === "string") return hoofddoelen;
  if (typeof hoofddoelen === "number" || typeof hoofddoelen === "boolean") return String(hoofddoelen);
  if (!Array.isArray(hoofddoelen)) return "";
  return hoofddoelen
    .map(function (row) {
      if (!row || typeof row !== "object") return "";
      var d = String(row.doel != null ? row.doel : "").trim();
      if (!d) return "";
      var c = String(row.context != null ? row.context : "").trim();
      return c ? d + " (" + c + ")" : d;
    })
    .filter(Boolean)
    .join(", ");
}

/** Sportcontext uit hoofddoelen, anders primairDoel als activiteit. */
function parseSportOfActiviteit(hoofddoelen, primairDoel) {
  var prim = primairDoel != null ? String(primairDoel).trim() : "";
  if (!Array.isArray(hoofddoelen) || hoofddoelen.length === 0) {
    return prim;
  }
  for (var i = 0; i < hoofddoelen.length; i++) {
    var row = hoofddoelen[i];
    if (!row || typeof row !== "object") continue;
    if (String(row.doel || "").trim().toLowerCase() === "sport") {
      var ctx = String(row.context != null ? row.context : "").trim();
      if (ctx) return ctx;
      return prim;
    }
  }
  return prim;
}

function parseBeschikbareLocatie(locatie, apparatuur) {
  var raw = String(locatie || "").trim().toLowerCase();
  var app = String(apparatuur || "").trim();
  var base = "";
  if (raw === "sportschool" || raw === "gym") base = "gym";
  else if (raw === "thuis") base = "home_gym";
  else if (raw === "buiten" || raw === "outdoor") base = "buiten";
  else if (raw === "combinatie") base = "gym en thuis";
  else base = raw || "";
  if (app && (base === "home_gym" || raw === "thuis")) {
    return base + " (" + app + ")";
  }
  if (app && base === "gym en thuis") {
    return base + " (" + app + ")";
  }
  return base || "";
}

function buildAanvullendeContext(stressniveau, apparatuur) {
  var stress = String(stressniveau != null ? stressniveau : "").trim();
  var app = String(apparatuur != null ? apparatuur : "").trim();
  if (!stress && !app) return "";
  if (stress && app) return "Stressniveau: " + stress + "/10. Beschikbaar materiaal: " + app + ".";
  if (stress) return "Stressniveau: " + stress + "/10.";
  return "Beschikbaar materiaal: " + app + ".";
}

function normalizeIntakeForSchema(intake) {
  if (!intake || typeof intake !== "object" || Array.isArray(intake)) return {};
  var o = Object.assign({}, intake);
  if (!o.naam && o.userName) o.naam = String(o.userName).trim();
  if (!o.userName && o.naam) o.userName = String(o.naam).trim();
  if (o.gewicht_kg == null && o.weight != null && String(o.weight).trim()) o.gewicht_kg = o.weight;
  if (o.lengte_cm == null && o.height != null && String(o.height).trim()) o.lengte_cm = o.height;
  if (!o.geslacht && o.gender) o.geslacht = o.gender;
  return o;
}

function deriveGebPartsForLeeftijd(intake) {
  if (
    intake &&
    intake.geboortedatum_dag != null &&
    intake.geboortedatum_maand != null &&
    intake.geboortedatum_jaar != null
  ) {
    return {
      dag: intake.geboortedatum_dag,
      maand: intake.geboortedatum_maand,
      jaar: intake.geboortedatum_jaar
    };
  }
  var iso = intake && String(intake.geboortedatum || "").trim();
  var m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return { dag: "", maand: "", jaar: "" };
  var monthNum = parseInt(m[2], 10);
  var day = parseInt(m[3], 10);
  var ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return {
    dag: day,
    maand: ABBR[monthNum - 1] || String(monthNum),
    jaar: m[1]
  };
}

function buildSchemaPromptData(intake) {
  var i = normalizeIntakeForSchema(intake);
  var hoofdArr = getHoofddoelenArrayFromIntake(i);
  var primairForParse =
    hoofdArr.length > 0 ? hoofdArr : i.primair_doel != null ? i.primair_doel : [];
  var primairStr = parsePrimairDoel(primairForParse);
  var sportAct = parseSportOfActiviteit(hoofdArr, primairStr);
  var geb = deriveGebPartsForLeeftijd(i);
  var leeftijd = calculateLeeftijd(geb.dag, geb.maand, geb.jaar);
  if (!leeftijd && i.leeftijd != null && String(i.leeftijd).trim()) {
    leeftijd = String(i.leeftijd).trim();
  }
  var sess = i.sessieduur_minuten;
  var sessN = parseInt(String(sess != null ? sess : "").trim(), 10);
  var sessOut =
    sessN === 120 || sess === 120 || sess === "120" ? "120+ minuten" : sess != null && sess !== "" ? sess : "";
  var locCode = String(i.beschikbare_locatie || "").trim().toLowerCase();
  var appStr = i.apparatuur != null && String(i.apparatuur).trim() ? String(i.apparatuur).trim() : "";
  var beschLoc = parseBeschikbareLocatie(locCode || i.beschikbare_locatie, appStr);
  var bless = String(i.blessures_of_beperkingen || "").trim() || "geen";
  var hasDead =
    i.heeft_deadline === true ||
    i.heeft_deadline === 1 ||
    i.heeft_deadline === "ja" ||
    i.heeft_deadline === "Ja";
  var aanv = buildAanvullendeContext(i.stressniveau, appStr);
  var out = {
    naam: String(i.naam || i.userName || "").trim(),
    primair_doel: primairStr,
    sport_of_activiteit: sportAct,
    niveau: String(i.niveau || "").trim(),
    trainingsdagen_per_week: i.trainingsdagen_per_week,
    sessieduur_minuten: sessOut,
    beschikbare_locatie: beschLoc,
    leeftijd: leeftijd,
    geslacht: String(i.geslacht || i.gender || "").trim(),
    gewicht_kg: i.gewicht_kg != null ? i.gewicht_kg : i.weight,
    lengte_cm: i.lengte_cm != null ? i.lengte_cm : i.height,
    blessures_of_beperkingen: bless,
    slaap_uren: i.slaap_uren,
    dagelijks_activiteitsniveau: i.dagelijks_activiteitsniveau != null ? i.dagelijks_activiteitsniveau : null,
    aanvullende_context: aanv
  };
  if (hasDead && String(i.competitie_datum || "").trim()) {
    out.competitie_datum = String(i.competitie_datum).trim();
  }
  var ssd = String(i.schema_startdatum || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(ssd)) {
    out.schema_startdatum = ssd;
  }
  return out;
}

/** Eerste regel user prompt: expliciete startdatum-instructie voor de AI (ISO YYYY-MM-DD). */
function schemaStartDatumInstructionLine(iso) {
  var d = String(iso || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return "";
  return (
    "BELANGRIJK: Het schema begint op " +
    d +
    ". Dag 1 van Week 1 is " +
    d +
    ". Genereer het schema zodat alle datums kloppen vanaf deze startdatum."
  );
}

function hasHoofddoelenContent(intake) {
  if (getHoofddoelenArrayFromIntake(intake).length > 0) return true;
  var p = String(intake.primair_doel || "").trim();
  if (p && p !== "—") return true;
  if (Array.isArray(intake.doel_type) && intake.doel_type.length > 0) return true;
  return false;
}

function validateSchemaIntakeMandatory(intake) {
  var i = normalizeIntakeForSchema(intake);
  var miss = [];
  if (!String(i.naam || i.userName || "").trim()) miss.push("naam");
  if (!String(i.geslacht || i.gender || "").trim()) miss.push("geslacht");
  var gw = i.gewicht_kg != null ? i.gewicht_kg : i.weight;
  if (gw == null || String(gw).trim() === "") miss.push("gewicht_kg");
  var len = i.lengte_cm != null ? i.lengte_cm : i.height;
  if (len == null || String(len).trim() === "") miss.push("lengte_cm");
  if (!hasHoofddoelenContent(i)) miss.push("hoofddoelen");
  if (!String(i.niveau || "").trim()) miss.push("niveau");
  if (i.trainingsdagen_per_week == null || String(i.trainingsdagen_per_week).trim() === "") {
    miss.push("trainingsdagen_per_week");
  }
  if (i.sessieduur_minuten == null || String(i.sessieduur_minuten).trim() === "") {
    miss.push("sessieduur_minuten");
  }
  if (!String(i.beschikbare_locatie || "").trim()) miss.push("beschikbare_locatie");
  if (miss.length) {
    return {
      ok: false,
      message: "Ontbrekende of lege verplichte intakevelden: " + miss.join(", ") + "."
    };
  }
  return { ok: true };
}

var TRAINER_STRUCTURED_START =
  "Gestructureerde intake (exact deze velden — verwerk alles):\n";
var TRAINER_STRUCTURED_END = "\n\nINTAKEPROFIEL (vrije tekst, zelfde gegevens):";

function extractStructuredIntakeFromTrainerContent(content) {
  if (typeof content !== "string") return null;
  var i = content.indexOf(TRAINER_STRUCTURED_START);
  if (i < 0) return null;
  var j = i + TRAINER_STRUCTURED_START.length;
  var k = content.indexOf(TRAINER_STRUCTURED_END, j);
  if (k < 0) return null;
  var jsonStr = content.slice(j, k).trim();
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    return null;
  }
}

function augmentIntakeFromTrainerProfielSection(content, parsed) {
  var o = Object.assign({}, parsed || {});
  var idx = content.indexOf("INTAKEPROFIEL (vrije tekst, zelfde gegevens):");
  if (idx < 0) return o;
  var tail = content.slice(idx);
  var nm = tail.match(/Naam:\s*([^\n]+)/);
  if (nm && !String(o.userName || o.naam || "").trim()) {
    o.userName = nm[1].trim();
    o.naam = nm[1].trim();
  }
  var gw = tail.match(/Gewicht:\s*([0-9.,]+)\s*kg/i);
  if (gw && (o.gewicht_kg == null || String(o.gewicht_kg).trim() === "") && (o.weight == null || String(o.weight).trim() === "")) {
    o.gewicht_kg = gw[1].trim().replace(",", ".");
  }
  var lenM = tail.match(/Lengte:\s*([0-9.,]+)\s*cm/i);
  if (lenM && (o.lengte_cm == null || String(o.lengte_cm).trim() === "") && (o.height == null || String(o.height).trim() === "")) {
    o.lengte_cm = lenM[1].trim().replace(",", ".");
  }
  return o;
}

function replaceStructuredIntakeJsonInTrainerContent(content, promptData) {
  var i = content.indexOf(TRAINER_STRUCTURED_START);
  var k = content.indexOf(TRAINER_STRUCTURED_END, i + TRAINER_STRUCTURED_START.length);
  if (i < 0 || k < 0) return content;
  var j = i + TRAINER_STRUCTURED_START.length;
  return content.slice(0, j) + JSON.stringify(promptData, null, 2) + content.slice(k);
}

function validateAndRewriteSchemaIntakeInPayload(payload) {
  var msgs = payload.messages;
  if (!Array.isArray(msgs) || !msgs.length) return { ok: true };
  var c0 = msgs[0].content;
  if (typeof c0 !== "string") return { ok: true };
  var extracted = extractStructuredIntakeFromTrainerContent(c0);
  if (!extracted) {
    return {
      ok: false,
      message:
        "Kon gestructureerde intake niet uit het gebruikersbericht halen (marker of JSON ontbreekt of is ongeldig)."
    };
  }
  var merged = augmentIntakeFromTrainerProfielSection(c0, extracted);
  var v = validateSchemaIntakeMandatory(merged);
  if (!v.ok) return v;
  var promptData = buildSchemaPromptData(merged);
  msgs[0].content = replaceStructuredIntakeJsonInTrainerContent(c0, promptData);
  var lead = schemaStartDatumInstructionLine(promptData.schema_startdatum);
  if (lead) msgs[0].content = lead + "\n\n" + msgs[0].content;
  return { ok: true, promptData: promptData };
}

/** Body van POST /api/generate-block: o.a. intakeProfile, vorigProgramma, trainingHistorie, vorigBlokNummer, model. */
function buildGenerateBlockUserContent(body, schemaPayloadPre) {
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
  var schemaPayload =
    schemaPayloadPre != null && typeof schemaPayloadPre === "object" && !Array.isArray(schemaPayloadPre)
      ? schemaPayloadPre
      : intake && typeof intake === "object" && !Array.isArray(intake)
        ? buildSchemaPromptData(intake)
        : {};
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
  var startInstr = schemaStartDatumInstructionLine(schemaPayload.schema_startdatum);
  if (startInstr) lines.push(startInstr);
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
  lines.push(stringifyBlockPayloadSection("=== GEBRUIKERSPROFIEL (intake / localStorage) ===", schemaPayload));
  if (
    intake &&
    typeof intake === "object" &&
    intake.sport_relatie != null &&
    String(intake.sport_relatie).trim()
  ) {
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

const INTAKE_HANDSHAKE_SYSTEM =
  "Je bent DREVN — een persoonlijke coach met karakter. Geen app, geen robot. Je hebt zojuist iemand leren kennen via een intake. Nu sta je op, geef je een hand en zeg je in 2-3 korte zinnen wat je ziet en wat jullie gaan doen. Spreek de persoon aan bij naam. Gebruik hun doel, niveau en context. Wees direct, warm, zelfverzekerd. Geen lijst, geen samenvatting — gewoon een coach die zegt: ik heb je gehoord, we gaan aan het werk. Eindig altijd vooruitkijkend. Maximaal 40 woorden. Schrijf in het Nederlands.";

function ageYearsFromBirthIso(iso) {
  var m = String(iso || "")
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  var y = parseInt(m[1], 10);
  var mo = parseInt(m[2], 10) - 1;
  var d = parseInt(m[3], 10);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  var birth = new Date(y, mo, d);
  if (isNaN(birth.getTime())) return null;
  var today = new Date();
  var age = today.getFullYear() - birth.getFullYear();
  var md = today.getMonth() - birth.getMonth();
  if (md < 0 || (md === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

function formatHandshakeSlaapUren(v) {
  if (v == null || v === "") return "—";
  var s = String(v).trim();
  if (!s) return "—";
  if (/^[0-9]+([.,][05])?$/.test(s)) return s.replace(",", ".");
  return s;
}

function formatHandshakeDoel(intake) {
  if (!intake || typeof intake !== "object") return "—";
  var arr = getHoofddoelenArrayFromIntake(intake);
  var prim = parsePrimairDoel(arr.length ? arr : intake.primair_doel != null ? intake.primair_doel : []).trim();
  var types = Array.isArray(intake.doel_type)
    ? intake.doel_type
        .map(function (x) {
          return String(x || "").trim();
        })
        .filter(Boolean)
        .join(", ")
    : "";
  if (prim && types) return prim + " (" + types + ")";
  return prim || types || "—";
}

function formatHandshakeLocatie(intake) {
  if (!intake || typeof intake !== "object") return "—";
  var pl = String(intake.pl_locatie || "").trim();
  if (pl) return pl;
  var code = String(intake.beschikbare_locatie || "").trim();
  if (!code) return "—";
  var c = code.toLowerCase();
  if (c === "thuis") return "Thuis";
  if (c === "sportschool" || c === "gym") return "Sportschool";
  if (c === "outdoor" || c === "buiten") return "Outdoor";
  return code;
}

/** Leesbare user message voor POST /api/intake-handshake (Anthropic user role). */
function buildIntakeHandshakeUserMessage(intake) {
  intake = intake && typeof intake === "object" && !Array.isArray(intake) ? intake : {};
  var naam = String(intake.userName || "").trim() || "—";
  var geb = String(intake.geboortedatum || "").trim();
  var age = ageYearsFromBirthIso(geb);
  var leeftijd = age != null && Number.isFinite(age) ? String(age) : "—";
  var gewicht = String(intake.weight || "").trim() || "—";
  var lengte = String(intake.height || "").trim() || "—";
  var doel = formatHandshakeDoel(intake);
  var niveau = String(intake.niveau || "").trim() || "—";
  var dagen = String(intake.trainingsdagen_per_week || "").trim() || "—";
  var minuten = String(intake.sessieduur_minuten || "").trim() || "—";
  var locatie = formatHandshakeLocatie(intake);
  var slaapRaw = formatHandshakeSlaapUren(intake.slaap_uren);
  var slaapLine =
    slaapRaw === "—" ? "—" : /uur/i.test(slaapRaw) ? slaapRaw : slaapRaw + " uur";
  var stress = String(intake.stressniveau || "").trim() || "—";
  var bless = String(intake.blessures_of_beperkingen || "").trim() || "—";
  return (
    "Naam: " +
    naam +
    "\nLeeftijd: " +
    leeftijd +
    "\nGewicht: " +
    gewicht +
    "kg, Lengte: " +
    lengte +
    "cm\nDoel: " +
    doel +
    "\nNiveau: " +
    niveau +
    "\nTrainingsdagen: " +
    dagen +
    " per week, " +
    minuten +
    " min per sessie\nLocatie: " +
    locatie +
    "\nSlaap: " +
    slaapLine +
    ", Stress: " +
    stress +
    "/10\nBlessures: " +
    bless
  );
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
    (pathOnly === "/api/generate" ||
      pathOnly === "/api/generate-block" ||
      pathOnly === "/api/intake-handshake")
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

  if (
    pathOnly !== "/api/generate" &&
    pathOnly !== "/api/generate-block" &&
    pathOnly !== "/api/intake-handshake"
  ) {
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

  if (pathOnly === "/api/intake-handshake") {
    let bodyStrHs;
    try {
      bodyStrHs = await collectRequestBody(req);
    } catch (eHs) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Body lezen mislukt" } }));
      return;
    }
    var clientHs;
    try {
      clientHs = JSON.parse(bodyStrHs || "{}");
    } catch (eParse) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Ongeldige JSON body" } }));
      return;
    }
    const rawKeyHs = process.env.ANTHROPIC_API_KEY || "";
    const apiKeyHs = String(rawKeyHs || "")
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!apiKeyHs || apiKeyHs === "JOUW_KEY") {
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
    var intakeHs =
      clientHs && clientHs.intake && typeof clientHs.intake === "object" && !Array.isArray(clientHs.intake)
        ? clientHs.intake
        : clientHs && typeof clientHs === "object"
          ? clientHs
          : {};
    var userMsgHs = buildIntakeHandshakeUserMessage(intakeHs);
    var handshakePayload = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 100,
      system: INTAKE_HANDSHAKE_SYSTEM,
      messages: [{ role: "user", content: userMsgHs }]
    };
    try {
      var outHs = await callAnthropicMessages(apiKeyHs, handshakePayload, { maxAttempts: 4 });
      var overloadHs = new Set([429, 502, 503, 529]);
      if (
        MODEL_FALLBACK &&
        handshakePayload &&
        typeof handshakePayload.model === "string" &&
        handshakePayload.model !== MODEL_FALLBACK &&
        outHs.status >= 400 &&
        overloadHs.has(outHs.status)
      ) {
        var payloadHs2 = Object.assign({}, handshakePayload, { model: MODEL_FALLBACK });
        outHs = await callAnthropicMessages(apiKeyHs, payloadHs2, { maxAttempts: 3 });
      }
      res.writeHead(outHs.status, { "Content-Type": outHs.contentType });
      res.end(outHs.text);
    } catch (errHs) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: (errHs && errHs.message) || "Proxy naar Anthropic mislukt" }
        })
      );
    }
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
    var intakeBlock =
      clientBody.intakeProfile != null
        ? clientBody.intakeProfile
        : clientBody.intake != null
          ? clientBody.intake
          : clientBody.gebruikersprofiel != null
            ? clientBody.gebruikersprofiel
            : null;
    if (!intakeBlock || typeof intakeBlock !== "object" || Array.isArray(intakeBlock)) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          error: { message: "intakeProfile / intake ontbreekt of is ongeldig." }
        })
      );
      return;
    }
    var vBlock = validateSchemaIntakeMandatory(intakeBlock);
    if (!vBlock.ok) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: { message: vBlock.message } }));
      return;
    }
    let schemaSystemText = "";
    try {
      schemaSystemText = await loadSchemaGenerationPrompt();
    } catch (e) {
      console.warn("[generate-block] schema prompt:", e && e.message);
    }
    if (!String(schemaSystemText).trim()) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message:
              "Kon schema-generation-elite-v3.txt niet lezen. Controleer of het bestand in de projectmap staat."
          }
        })
      );
      return;
    }
    var intakeForPrompt = buildSchemaPromptData(intakeBlock);
    console.log('schema_startdatum:', intakeForPrompt.schema_startdatum);
    const blockModel =
      clientBody &&
      typeof clientBody.model === "string" &&
      clientBody.model.trim()
        ? clientBody.model.trim()
        : (process.env.ANTHROPIC_MODEL || "").trim() || "claude-sonnet-4-20250514";
    const userContent = buildGenerateBlockUserContent(clientBody, intakeForPrompt);
    const anthropicBlockPayload = {
      model: blockModel,
      max_tokens: 16384,
      system: systemPromptWithEphemeralCache(schemaSystemText),
      messages: [{ role: "user", content: userContent }]
    };
    try {
      let out = await callAnthropicMessages(apiKey, anthropicBlockPayload);
      const overload = new Set([429, 502, 503, 529]);
      const ok = out.status >= 200 && out.status < 300;
      if (
        MODEL_FALLBACK &&
        anthropicBlockPayload &&
        typeof anthropicBlockPayload.model === "string" &&
        anthropicBlockPayload.model !== MODEL_FALLBACK &&
        !ok &&
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
  var intakeForPrompt = {};
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
      const schemaSys = await loadSchemaGenerationPrompt();
      if (schemaSys) payload.system = systemPromptWithEphemeralCache(schemaSys);
    } catch (e) {
      console.warn("[schema] schema-generation-elite-v3.txt niet gelezen:", e && e.message);
    }
    var vr = validateAndRewriteSchemaIntakeInPayload(payload);
    if (!vr.ok) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: { message: vr.message } }));
      return;
    }
    if (vr.promptData && typeof vr.promptData === "object") intakeForPrompt = vr.promptData;
  }

  if (schemaIntake) {
    console.log('schema_startdatum:', intakeForPrompt.schema_startdatum);
  }

  try {
    let out = await callAnthropicMessages(apiKey, payload);
    const overload = new Set([429, 502, 503, 529]);
    const okGen = out.status >= 200 && out.status < 300;
    if (
      MODEL_FALLBACK &&
      payload &&
      typeof payload.model === "string" &&
      payload.model !== MODEL_FALLBACK &&
      !okGen &&
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
  console.log("POST %s", `http://localhost:${PORT}/api/intake-handshake`);
  console.log("GET  %s", `http://localhost:${PORT}/api/health`);
  console.log("App:  %s", `http://localhost:${PORT}/`);
  if (MODEL_FALLBACK) console.log("Fallback-model bij overload: %s", MODEL_FALLBACK);
});
