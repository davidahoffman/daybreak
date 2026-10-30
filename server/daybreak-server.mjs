#!/usr/bin/env node
// Daybreak server — the exchange between any brain and any handset.
//
//   dossier.json (written by any agent by ~07:30)
//        │  validated → brief.wav pre-rendered (TTS) → ring armed
//        ▼
//   HTTP protocol (port 7745 = the ring time)
//        ├─ GET  /api/health         liveness, no auth
//        ├─ GET  /api/status         dossier freshness, ring state
//        ├─ GET  /api/dossier        full dossier JSON
//        ├─ GET  /api/brief.wav      pre-rendered spoken brief (marks answered)
//        ├─ GET  /api/brief-meta     per-paragraph timings for highlight sync
//        ├─ POST /api/feedback       reader comment on a paragraph → next dossier prompt
//        ├─ POST /api/stt            raw audio → {transcript}
//        ├─ POST /api/turn           {text} or raw audio → reply text + audio
//        ├─ POST /api/brief-ended    brief finished → resume music we paused
//        ├─ POST /api/hangup         end session
//        ├─ POST /api/test-ring      force the Mac ring now
//        └─ GET  /call               universal web handset
//
// Run: node daybreak-server.mjs [--port 7745] [--state /path/to/state]

import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { hostname, homedir } from "node:os";
import { execFile, execFileSync } from "node:child_process";

import "./lib/env.mjs";
import { loadDossier, localDateString } from "./lib/dossier.mjs";
import { ttsLong, wavConcat, wavDuration, DEFAULT_CHAT_MODEL } from "./lib/ai.mjs";
import { CallSession } from "./lib/session.mjs";
import { RingScheduler } from "./lib/ring.mjs";
import { slackLegIfNeeded } from "./lib/slackleg.mjs";
import { notify } from "./lib/notify.mjs";
import { pauseSpotify, resumeSpotify } from "./lib/spotify.mjs";
import { startMicWatch } from "./lib/micwatch.mjs";

const VERSION = "0.1.0";
const serverDir = dirname(fileURLToPath(import.meta.url));
const appDir = dirname(serverDir);

// ---------- flags / paths ----------
const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const stateDir = flag("state", join(appDir, "state"));
mkdirSync(join(stateDir, "logs"), { recursive: true });

const paths = {
  config: join(stateDir, "config.json"),
  token: join(stateDir, "device-token"),
  dossier: join(stateDir, "dossier.json"),
  briefWav: join(stateDir, "brief.wav"),
  briefMeta: join(stateDir, "brief-meta.json"),
  ringState: join(stateDir, "ring-state.json"),
  feedback: join(stateDir, "brief-feedback.jsonl"),
  log: join(stateDir, "logs", "server.jsonl"),
  webCall: join(appDir, "web", "call.html"),
  missNotice: (date) => join(stateDir, `miss-notice-${date}.json`),
  prefetchLog: join(stateDir, "logs", "prefetch.jsonl"),
};

// ---------- config ----------
const DEFAULT_CONFIG = {
  port: 7745,
  ringTime: "07:45",
  ringDeadline: "09:30",
  retryMinutes: 20,
  weekdaysOnly: true,
  voice: "nova",
  chatModel: DEFAULT_CHAT_MODEL,
  userName: null, // your first name, so the in-call voice knows who it works for
  sttLanguage: "en",
  slackLeg: false, // post brief.wav + headline to Slack (delivery insurance)
  slackPostTime: "07:40",
};
function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(paths.config, "utf8")) };
  } catch {
    writeFileSync(paths.config, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }
}
let config = loadConfig();
config.port = Number(flag("port", config.port));

// ---------- device token ----------
function loadToken() {
  if (existsSync(paths.token)) return readFileSync(paths.token, "utf8").trim();
  const t = randomBytes(16).toString("hex");
  writeFileSync(paths.token, t + "\n", { mode: 0o600 });
  return t;
}
const TOKEN = loadToken();

// ---------- logging ----------
function log(event, extra = {}) {
  const entry = { ts: new Date().toISOString(), event, ...extra };
  try {
    appendFileSync(paths.log, JSON.stringify(entry) + "\n");
  } catch {}
  console.log(`[daybreak] ${event}`, Object.keys(extra).length ? JSON.stringify(extra) : "");
}

// ---------- spotify pause/resume ----------
const APPLESCRIPT_PAUSE =
  'if application "Spotify" is running then tell application "Spotify" to if player state is playing then pause & return "paused"';
let spotifyPausedBy = null; // {via, deviceId?} — set only when we paused something
async function resumeSpotifyIfWePaused(trigger) {
  const paused = spotifyPausedBy;
  if (!paused) return;
  spotifyPausedBy = null;
  if (paused.via === "web_api") {
    log("spotify_resume", { trigger, via: "web_api", result: await resumeSpotify(paused.deviceId) });
  } else {
    execFile("/usr/bin/osascript", ["-e", 'tell application "Spotify" to play'], { timeout: 5_000 }, (err) =>
      log("spotify_resume", { trigger, via: "applescript", result: err ? String(err.message || err).slice(0, 200) : "resumed" })
    );
  }
}

// Meet / any call holds the mic → pause Spotify; release → resume (lib/micwatch.mjs).
startMicWatch({ log });

// ---------- dossier + brief audio ----------
let dossierState = loadDossier(paths.dossier);
let briefRendering = false;

function briefMeta() {
  try {
    return JSON.parse(readFileSync(paths.briefMeta, "utf8"));
  } catch {
    return null;
  }
}
function briefAudioReady() {
  const meta = briefMeta();
  return Boolean(
    meta &&
    existsSync(paths.briefWav) &&
    dossierState.valid &&
    meta.generatedAt === dossierState.dossier?.generatedAt
  );
}

// The brief renders paragraph by paragraph so brief-meta.json can carry exact
// start/end offsets per paragraph — the handset highlights the one being
// spoken. Old single-block scripts still work: one segment, no highlight sync.
function briefParagraphs(script) {
  return script.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
}

async function renderBriefIfNeeded() {
  dossierState = loadDossier(paths.dossier);
  if (!dossierState.valid) return;
  if (briefAudioReady() || briefRendering) return;
  briefRendering = true;
  const t0 = Date.now();
  try {
    // Capture before the awaits: if dossier.json is replaced mid-render, the
    // finished audio must carry the OLD generatedAt so it re-renders.
    const renderedFor = dossierState.dossier.generatedAt;
    const script = dossierState.dossier.briefScript;
    const paragraphs = briefParagraphs(script);
    log("brief_render_start", { chars: script.length, paragraphs: paragraphs.length });
    const wavs = [];
    const segments = [];
    let cursor = 0;
    for (const text of paragraphs) {
      const wav = await ttsLong(text, { voice: config.voice });
      const dur = wavDuration(wav);
      segments.push({ text, startSec: Number(cursor.toFixed(3)), endSec: Number((cursor + dur).toFixed(3)) });
      cursor += dur;
      wavs.push(wav);
    }
    const wav = wavConcat(wavs);
    writeFileSync(paths.briefWav, wav);
    // segments ride in the same write as generatedAt so briefAudioReady()
    // stays atomic — meta and audio can never disagree about which dossier
    writeFileSync(
      paths.briefMeta,
      JSON.stringify(
        { generatedAt: renderedFor, renderedAt: new Date().toISOString(), segments },
        null,
        2
      )
    );
    log("brief_render_done", { ms: Date.now() - t0, bytes: wav.length, segments: segments.length });
  } catch (err) {
    log("brief_render_error", { error: String(err) });
  } finally {
    briefRendering = false;
  }
}
setInterval(renderBriefIfNeeded, 20_000).unref?.();
renderBriefIfNeeded();

// Slack voicemail leg — isolated from render/ring: its failures only log, and
// the success marker means the interval retries until Slack confirms.
setInterval(() => {
  slackLegIfNeeded({
    config,
    dossierState,
    briefAudioReady: briefAudioReady(),
    stateDir,
    wavPath: paths.briefWav,
    log,
  }).catch((err) => log("slack_leg_error", { error: String(err) }));
}, 30_000).unref?.();

// ---------- missed-window notice ----------
// Fail loud. On 2026-08-24 the ring window passed with ringCount 0 and the user
// found out hours later by asking — watchdog_gave_up had gone to a log file
// nobody reads, and the Slack upload is silent, so it can't notify either.
// Once per weekday, after ringDeadline with no ring, push the reason instead.
// Did the gather starve because the machine slept, rather than fail on merit?
// The signature is unambiguous: prefetch's killer is a Node setTimeout, and Node
// timers only advance while the process is scheduled, so a 25-minute timer that
// fires after 58 minutes of wall clock means ~33 minutes frozen. Reporting that
// as "the gather failed" sends the user reading logs for a bug that isn't there —
// the machine simply never gave it CPU. Returns null when there's no such
// evidence, so the caller falls back to describing actual state.
function sleepStarvationEvidence() {
  let starts = [];
  try {
    const today = localDateString();
    for (const line of readFileSync(paths.prefetchLog, "utf8").trim().split("\n")) {
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      if (!d.ts?.startsWith(today.slice(0, 4))) continue;
      // Local-date match, not the UTC prefix: an 07:06 start at UTC+2 is 05:06Z.
      if (new Date(d.ts).toDateString() !== new Date().toDateString()) continue;
      if (d.event === "claude_start") starts.push({ at: new Date(d.ts).getTime(), timeoutMin: d.timeoutMin || 25 });
      if (d.event === "claude_timeout" && starts.length) {
        const s0 = starts[starts.length - 1];
        const wallMin = Math.round((new Date(d.ts).getTime() - s0.at) / 60_000);
        if (wallMin > s0.timeoutMin * 1.5) return { wallMin, timeoutMin: s0.timeoutMin };
      }
    }
  } catch {}
  return null;
}

function powerSource() {
  try {
    const out = execFileSync("/usr/bin/pmset", ["-g", "batt"], { encoding: "utf8", timeout: 5_000 });
    if (/AC Power/.test(out)) return "AC";
    if (/Battery Power/.test(out)) return "battery";
  } catch {}
  return null;
}

// Is today's most recent gather outcome a deferral (exit 3: battery + closed
// lid) with nothing terminal after it? A pending deferral is a plan, not a
// failure — the watchdog gathers at first real wake. Terminal events clear it;
// claude_start deliberately does NOT: an in-flight post-wake gather should
// still hold the miss notice until it lands or fails.
function pendingDeferral() {
  try {
    let pending = null;
    for (const line of readFileSync(paths.prefetchLog, "utf8").trim().split("\n")) {
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      if (new Date(d.ts).toDateString() !== new Date().toDateString()) continue;
      if (d.event === "gather_deferred") pending = d;
      else if (["claude_done", "no_dossier_written", "install_error", "skip_already_valid", "dossier_installed"].includes(d.event)) pending = null;
    }
    return pending;
  } catch {}
  return null;
}

function missNoticeIfNeeded() {
  const today = localDateString();
  const marker = paths.missNotice(today);
  if (existsSync(marker)) return;

  const now = new Date();
  if (config.weekdaysOnly && (now.getDay() === 0 || now.getDay() === 6)) return;
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  if (hhmm <= (config.ringDeadline || "09:30")) return;

  // Rang, or the user answered, means the product worked — nothing to report.
  if (ringScheduler.state.date === today && (ringScheduler.state.ringCount > 0 || ringScheduler.state.answeredAt)) return;

  dossierState = loadDossier(paths.dossier);

  // A late ring is imminent (late-open grace in ring.mjs): skip without a
  // marker rather than misreport a morning the ring is about to save.
  if (ringScheduler.shouldRing(now).ring) return;

  const noDossier = !dossierState.exists || dossierState.dossier?.date !== today || !dossierState.valid;
  const deferred = noDossier ? pendingDeferral() : null;
  // A deferred gather is a plan, not a failure: before the 15:00 late-ring
  // cutoff, hold the notice — the watchdog gathers at first wake and the late
  // ring delivers ("syncs once woken, then sends"). Only once the same-day
  // window is truly gone does the deferral become the report.
  if (deferred && hhmm < "15:00") return;
  const starved = noDossier ? sleepStarvationEvidence() : null;

  let reason;
  if (deferred) {
    reason = `the Mac was on battery with the lid closed, so the gather deferred rather than run into a sleeping machine, and the lid never opened before 15:00 — no same-day brief was possible`;
  } else if (starved) {
    // Lead with the cause and the one action that fixes it. caffeinate cannot
    // help here: -i only blocks idle sleep, and -s is AC-only, so on battery a
    // closed lid gets dark-wake windows the power manager closes regardless
    // (2026-08-25: the 06:50 scheduled wake fired on time and macOS slept it
    // again 15 seconds later). On AC, pmset is configured never to sleep.
    const src = powerSource();
    reason =
      `the Mac slept through the ring window, so the gather never got CPU ` +
      `(a ${starved.timeoutMin}-minute timer took ${starved.wallMin} minutes of wall clock)` +
      `${src === "battery" ? ", and it is on battery now" : ""}. ` +
      `Plug in overnight: on AC this Mac is set never to sleep`;
  } else if (!dossierState.exists) reason = "no dossier was ever written and the gather left no starvation trace, so it failed on merit — read the claude log";
  else if (dossierState.dossier?.date !== today) reason = `newest dossier is for ${dossierState.dossier?.date}, not today`;
  else if (!dossierState.valid) reason = `dossier invalid: ${(dossierState.problems || []).join("; ")}`;
  else if (!briefAudioReady()) reason = "dossier is valid but brief.wav never rendered";
  else reason = "brief was ready but the ring never fired — check ring-state.json";

  writeFileSync(marker, JSON.stringify({ noticedAt: new Date().toISOString(), reason }, null, 2));
  log("miss_notice", { date: today, reason });
  notify({
    headline: `No Daybreak call this morning. ${reason}. Logs: apps/daybreak/state/logs/`,
    log,
  }).catch((err) => log("miss_notice_error", { error: String(err) }));
}
setInterval(missNoticeIfNeeded, 60_000).unref?.();

// ---------- timezone self-heal ----------
// Node caches the system timezone at startup and launchd caches calendar fire
// times at load — a laptop that lands in a new timezone keeps both on the old
// clock (after travel, prefetch fired at 06:55 in the old timezone).
// When the OS zone diverges from ours, reload the prefetch agent so launchd
// recomputes its fire times, then exit; KeepAlive restarts us on the new clock.
function nodeUtcOffset() {
  const mins = -new Date().getTimezoneOffset();
  const abs = Math.abs(mins);
  return `${mins < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}${String(abs % 60).padStart(2, "0")}`;
}
setInterval(() => {
  execFile("/bin/date", ["+%z"], (err, out) => {
    if (err || out.trim() === nodeUtcOffset()) return;
    log("tz_drift_restart", { os: out.trim(), node: nodeUtcOffset() });
    const domain = `gui/${process.getuid()}`;
    const plist = join(homedir(), "Library", "LaunchAgents", "com.daybreak.prefetch.plist");
    execFile("/bin/launchctl", ["bootout", `${domain}/com.daybreak.prefetch`], () => {
      // exit 1, not 0: we're demanding a respawn — nonzero survives any future
      // KeepAlive/SuccessfulExit config and reads as "restart me" to launchd
      execFile("/bin/launchctl", ["bootstrap", domain, plist], () => process.exit(1));
    });
  });
}, 600_000).unref?.();

// ---------- prefetch watchdog ----------
// launchd's calendar fires are fragile: fire times go stale on tz changes,
// missed fires coalesce into ONE wake-time attempt, and a failed gather (lid
// opened before Wi-Fi is up) never retries. This KeepAlive process is the only
// thing guaranteed to be running, so it re-kicks prefetch.mjs until a valid
// same-day dossier exists — 06:50–15:00 weekdays, 12 min apart, 6 tries/day.
// The window opens with the pmset wake, not after the ring: on a battery
// morning launchd's coalesced fire gets consumed as a deferral (exit 3), so a
// lid opened at 07:10 would otherwise wait until 07:35 for its gather; from
// 06:50 the watchdog starts it within 150s of the wake (brief ready ~07:20,
// rings 07:45 on schedule). It also covers the known AC gap between the 06:50
// pmset wake and the first launchd fire. Freshness/skip policy lives inside
// prefetch.mjs (early-exit + lock make redundant kicks no-ops); the watchdog
// only guarantees attempts happen.
const prefetchScript = join(appDir, "prefetch", "prefetch.mjs");
let watchdog = { date: "", attempts: 0, running: false, lastKickAt: 0 };
setInterval(() => {
  const now = new Date();
  if (config.weekdaysOnly && (now.getDay() === 0 || now.getDay() === 6)) return;
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  if (hhmm < "06:50" || hhmm >= "15:00") return;

  const today = localDateString();
  if (watchdog.date !== today) watchdog = { date: today, attempts: 0, running: false, lastKickAt: 0 };

  // dossierState reloads every 20s, so valid/mtime are live. Stale-but-valid
  // only matters while the ring can still fire: a brief gathered last evening
  // must be re-gathered before it rings (2026-07-23 shipped an 11h-old brief),
  // but a fresh 07:00 gather is not worth redoing at 13:00.
  const staleForRing =
    hhmm < (config.ringDeadline || "09:30") &&
    Date.now() - (dossierState.mtime || 0) > 6 * 60 * 60_000;
  const needGather = !dossierState.valid || staleForRing;
  if (!needGather || watchdog.running) return;
  if (Date.now() - watchdog.lastKickAt < 12 * 60_000) return;
  if (watchdog.attempts >= 6) {
    if (watchdog.attempts === 6) {
      log("watchdog_gave_up", { date: today, attempts: watchdog.attempts });
      watchdog.attempts++; // silence: log the surrender exactly once
    }
    return;
  }

  watchdog.running = true;
  watchdog.lastKickAt = Date.now();
  watchdog.attempts++;
  log("watchdog_prefetch_start", { attempt: watchdog.attempts, valid: dossierState.valid, staleForRing });
  // login shell so the brain binary resolves on PATH — same env as the launchd job
  execFile(
    "/bin/zsh",
    ["-lc", `exec node ${JSON.stringify(prefetchScript)}`],
    { timeout: 30 * 60_000 },
    (err, stdout = "", stderr = "") => {
      watchdog.running = false;
      const code = err ? err.code ?? String(err.signal || err) : 0;
      log("watchdog_prefetch_done", {
        attempt: watchdog.attempts,
        code,
        tail: (stdout + stderr).slice(-300).trim(),
      });
      // exit 3 = gather deferred (battery + closed lid): the machine can't do
      // the work asleep. Refund the attempt and clear the spacing so the next
      // 150s tick retries — at first real wake (lid open) the deferral clears
      // and the gather runs within 2.5 minutes. Deferred retries are sub-second
      // refusals, so leaving them unlimited is deliberate.
      if (code === 3) {
        watchdog.attempts--;
        watchdog.lastKickAt = 0;
      }
    }
  );
}, 150_000).unref?.();

// ---------- session + ring ----------
const session = new CallSession({
  statePath: stateDir,
  userName: config.userName,
  model: config.chatModel,
  log,
});

const ringScheduler = new RingScheduler({
  config: () => config,
  statusFn: () => ({ dossierValid: dossierState.valid, briefAudioReady: briefAudioReady() }),
  ringStatePath: paths.ringState,
  token: () => TOKEN,
  log,
});
ringScheduler.start();
// Evaluate immediately too: a server restarted after the deadline (KeepAlive
// respawn, tz-heal exit) should report a missed window now, not up to a minute
// later. Safe here — missNoticeIfNeeded reads ringScheduler, which exists by
// this line; calling it any earlier would hit the const's temporal dead zone.
missNoticeIfNeeded();

// ---------- http plumbing ----------
function readBody(req, cap = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > cap) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

function isLocalRequest(req) {
  const a = req.socket.remoteAddress || "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

// A loopback socket alone isn't proof the page is ours: a site that DNS-rebinds
// its own hostname to 127.0.0.1 arrives from loopback too, but with its own Host.
// Only trust loopback when the browser was actually pointed at a loopback name.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
function isLoopbackHost(req) {
  const host = String(req.headers.host || "").toLowerCase();
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return LOOPBACK_HOSTS.has(name);
}

function authed(req, url) {
  const header = req.headers.authorization || "";
  if (header === `Bearer ${TOKEN}`) return true;
  if (url.searchParams.get("t") === TOKEN) return true;
  return false;
}

const AUDIO_EXT = {
  "audio/wav": "turn.wav",
  "audio/x-wav": "turn.wav",
  "audio/webm": "turn.webm",
  "audio/mp4": "turn.m4a",
  "audio/m4a": "turn.m4a",
  "audio/x-m4a": "turn.m4a",
  "audio/mpeg": "turn.mp3",
};

async function transcribeBody(req, body) {
  const mime = (req.headers["content-type"] || "audio/wav").split(";")[0].trim();
  const { stt } = await import("./lib/ai.mjs");
  return stt(body, { mime, filename: AUDIO_EXT[mime] || "turn.wav", language: config.sttLanguage });
}

// ---------- routes ----------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Authorization,Content-Type",
      });
      return res.end();
    }

    if (route === "GET /api/health") {
      return json(res, 200, { ok: true, name: "daybreak", version: VERSION });
    }

    if (url.pathname === "/" || route === "GET /call") {
      let html = readFileSync(paths.webCall, "utf8");
      const trusted = (isLocalRequest(req) && isLoopbackHost(req)) || authed(req, url);
      html = html.replace("__DAYBREAK_TOKEN__", trusted ? TOKEN : "");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    // Everything below requires the device token.
    if (!authed(req, url)) return json(res, 401, { error: "missing or bad token" });

    if (route === "GET /api/status") {
      dossierState = loadDossier(paths.dossier);
      const verdict = ringScheduler.shouldRing();
      return json(res, 200, {
        now: new Date().toISOString(),
        today: localDateString(),
        version: VERSION,
        dossier: {
          exists: dossierState.exists,
          valid: dossierState.valid,
          problems: dossierState.problems,
          date: dossierState.dossier?.date || null,
          generatedAt: dossierState.dossier?.generatedAt || null,
          headline: dossierState.dossier?.headline || null,
        },
        briefAudioReady: briefAudioReady(),
        ring: { ...ringScheduler.state, nextVerdict: verdict.why || "ready", ringTime: config.ringTime },
      });
    }

    if (route === "GET /api/dossier") {
      dossierState = loadDossier(paths.dossier);
      if (!dossierState.exists) return json(res, 404, { error: "no dossier yet" });
      return json(res, 200, dossierState.dossier);
    }

    if (route === "GET /api/brief.wav") {
      if (!briefAudioReady()) return json(res, 404, { error: "brief audio not ready" });
      if (url.searchParams.get("test") !== "1") ringScheduler.markAnswered();
      session.ensureDossier(dossierState.dossier);
      const wav = readFileSync(paths.briefWav);
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length, "Access-Control-Allow-Origin": "*" });
      return res.end(wav);
    }

    if (route === "GET /api/brief-meta") {
      if (!briefAudioReady()) return json(res, 404, { error: "brief audio not ready" });
      return json(res, 200, briefMeta());
    }

    // Reader feedback on a brief paragraph. Appended to brief-feedback.jsonl,
    // which prefetch.mjs folds into the next dossier prompt — the loop that
    // makes the brief improve daily.
    if (route === "POST /api/feedback") {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      const comment = String(body.comment || "").trim();
      if (!comment) return json(res, 400, { error: "empty comment" });
      const entry = {
        ts: new Date().toISOString(),
        briefDate: dossierState.dossier?.date || localDateString(),
        paragraphIndex: Number.isInteger(body.paragraphIndex) ? body.paragraphIndex : null,
        paragraphText: String(body.paragraphText || "").slice(0, 240),
        comment: comment.slice(0, 1000),
      };
      appendFileSync(paths.feedback, JSON.stringify(entry) + "\n");
      log("feedback", { paragraphIndex: entry.paragraphIndex, comment: entry.comment.slice(0, 120) });
      return json(res, 200, { ok: true });
    }

    if (route === "POST /api/answered") {
      // A test ring's call page carries test=1: answering it must not cancel
      // the real ring, the late ring, or the miss notice.
      if (url.searchParams.get("test") !== "1") ringScheduler.markAnswered();
      // Quiet the music before the brief plays. The Web API pauses whatever device
      // is active (e.g. the web player); the AppleScript is a desktop-app
      // fallback that never launches Spotify. Awaited so the pause lands before the
      // handset starts the brief; both are 5s-capped and non-fatal. Only a pause we
      // actually made is remembered, so the resume never starts music the user had stopped.
      spotifyPausedBy = null; // a stale flag from a closed tab must not resume later
      const spotify = await pauseSpotify();
      log("spotify_pause", { via: "web_api", ...spotify });
      if (spotify.result === "paused") {
        spotifyPausedBy = { via: "web_api", deviceId: spotify.deviceId };
      } else {
        execFile("/usr/bin/osascript", ["-e", APPLESCRIPT_PAUSE], { timeout: 5_000 }, (err, out = "") => {
          const result = err ? String(err.message || err).slice(0, 200) : out.trim() || "not_playing";
          if (result === "paused") spotifyPausedBy = { via: "applescript" };
          log("spotify_pause", { via: "applescript", result });
        });
      }
      return json(res, 200, { ok: true });
    }

    if (route === "POST /api/stt") {
      const body = await readBody(req);
      const t0 = Date.now();
      const transcript = await transcribeBody(req, body);
      log("stt", { ms: Date.now() - t0, chars: transcript.length });
      return json(res, 200, { transcript });
    }

    if (route === "POST /api/turn") {
      const body = await readBody(req);
      const ctype = (req.headers["content-type"] || "").split(";")[0].trim();
      let userText;
      let transcript = null;
      if (ctype === "application/json") {
        userText = String(JSON.parse(body.toString("utf8")).text || "").trim();
      } else {
        transcript = await transcribeBody(req, body);
        userText = transcript;
      }
      if (!userText) {
        return json(res, 200, {
          transcript: transcript || "",
          replyText: "I didn't catch that — say it once more?",
          replyAudioB64: null,
          capturedActions: [],
        });
      }

      dossierState = loadDossier(paths.dossier);
      if (dossierState.valid) session.ensureDossier(dossierState.dossier);
      const t0 = Date.now();
      const { replyText, capturedActions, degraded } = await session.turn(userText);
      const chatMs = Date.now() - t0;

      let replyAudioB64 = null;
      try {
        const wav = await ttsLong(replyText, { voice: config.voice });
        replyAudioB64 = wav.toString("base64");
      } catch (err) {
        log("reply_tts_error", { error: String(err) });
      }
      log("turn", { user: userText.slice(0, 120), chatMs, degraded: Boolean(degraded) });
      return json(res, 200, { transcript, replyText, replyAudioB64, format: "wav", capturedActions });
    }

    if (route === "POST /api/brief-ended") {
      await resumeSpotifyIfWePaused("brief_ended");
      return json(res, 200, { ok: true });
    }

    if (route === "POST /api/hangup") {
      await resumeSpotifyIfWePaused("hangup"); // hung up mid-brief
      session.reset(session.dossier);
      log("hangup", {});
      return json(res, 200, { ok: true });
    }

    if (route === "POST /api/test-ring") {
      ringScheduler.ring({ force: true });
      return json(res, 200, { ok: true, rang: true });
    }

    return json(res, 404, { error: `no route ${route}` });
  } catch (err) {
    log("request_error", { route, error: String(err) });
    return json(res, 500, { error: String(err) });
  }
});

server.listen(config.port, "0.0.0.0", () => {
  log("listening", {
    port: config.port,
    host: hostname(),
    stateDir,
    dossierValid: dossierState.valid,
    briefAudioReady: briefAudioReady(),
  });
  const host = hostname().toLowerCase().replace(/\.local$/, "");
  console.log(`[daybreak] handset URL: http://${host}.local:${config.port}/call`);
  console.log(`[daybreak] device token: ${paths.token}`);
});
