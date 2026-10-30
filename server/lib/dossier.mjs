// Dossier loading + the no-ring-without-brief gate.
//
// Shelly's 2026-06-24 bug class: an agent returns "Got it — I'll prepare your
// briefing" and the app rings with nothing to say. Daybreak's descendant of
// looksLikeBriefWorthRinging lives here: a dossier is only "valid" when it is
// today's, substantial, and not a meta-confirmation.

import { readFileSync, statSync } from "node:fs";

export function localDateString(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const META_CONFIRMATION = /^(ok(ay)?|sure|got it|will do|done|understood|sounds good|on it)\b[\s\S]{0,160}$/i;
const PROMISE_ONLY = /^(i('| a)?(ll| will| am going to)\s+(prepare|generate|put together|work on|get)|preparing|generating)\b/i;

export function validateDossier(dossier, { today = localDateString() } = {}) {
  const problems = [];
  if (!dossier || typeof dossier !== "object") return { valid: false, problems: ["not an object"] };
  if (dossier.date !== today) problems.push(`date is ${dossier.date}, today is ${today}`);
  // Type-check before trimming: a custom brain writing "headline": 42 must
  // fail validation, not throw and crash-loop the server.
  const str = (v) => (typeof v === "string" ? v : "");
  if (dossier.briefScript != null && typeof dossier.briefScript !== "string") problems.push("briefScript is not a string");
  if (dossier.headline != null && typeof dossier.headline !== "string") problems.push("headline is not a string");
  const script = str(dossier.briefScript).trim();
  if (script.length < 300) problems.push(`briefScript too short (${script.length} chars) — not a real brief`);
  if (META_CONFIRMATION.test(script)) problems.push("briefScript is a meta-confirmation, not a brief");
  if (PROMISE_ONLY.test(script)) problems.push("briefScript promises a brief instead of being one");
  const sentences = script.split(/[.!?]+/).filter((s) => s.trim().length > 8);
  if (sentences.length < 4) problems.push("briefScript has fewer than 4 real sentences");
  if (!dossier.sections || typeof dossier.sections !== "object" || Object.keys(dossier.sections).length < 2)
    problems.push("sections missing or near-empty");
  if (str(dossier.headline).trim().length < 8) problems.push("headline missing");
  return { valid: problems.length === 0, problems };
}

export function loadDossier(path) {
  let raw, mtime;
  try {
    raw = readFileSync(path, "utf8");
    mtime = statSync(path).mtimeMs;
  } catch {
    return { exists: false, valid: false, problems: ["dossier.json not found"], dossier: null, mtime: 0 };
  }
  let dossier;
  try {
    dossier = JSON.parse(raw);
  } catch (e) {
    return { exists: true, valid: false, problems: [`JSON parse: ${e.message}`], dossier: null, mtime };
  }
  const { valid, problems } = validateDossier(dossier);
  return { exists: true, valid, problems, dossier, mtime };
}

// Compact rendering of the dossier for the in-call system prompt. Evidence is
// included in full — exact quotes are the whole point of "what did Sam
// actually say".
export function dossierForPrompt(dossier) {
  const clone = { ...dossier };
  delete clone.briefScript; // the model gets the sections, not the script it already spoke
  return JSON.stringify(clone, null, 1);
}
