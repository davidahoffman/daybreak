#!/usr/bin/env node
// Daybreak prefetch — runs the brain, validates its dossier, installs it.
//
// The brain is `claude -p` (or any DAYBREAK_BRAIN_CMD) reading the composed
// dossier prompt on stdin, run from DAYBREAK_BRAIN_CWD so it picks up that
// directory's MCP servers and context. But NOTHING here trusts the brain: the dossier only lands in
// state/dossier.json after validateDossier passes. Garbage in → no ring, and
// yesterday's dossier is never overwritten by a broken run.
//
//   node prefetch.mjs                 gather via the brain (skips if today's dossier is valid)
//   node prefetch.mjs --force         gather even if today's dossier is valid
//   node prefetch.mjs --fixture       install fixtures/dossier-fixture.json re-dated to today (harness mode)
//   node prefetch.mjs --timeout-min 25
//
// launchd runs this at 06:50/06:55 with an 07:25 backstop, and the server's
// watchdog re-runs it on late wakes and failed gathers; the early-exit makes
// redundant fires no-ops and state/prefetch.lock makes overlapping ones
// single-flight. On battery with the lid closed it refuses to run at all
// (exit 3, `gather_deferred`): the machine force-sleeps regardless of
// assertions, so the gather waits for a real wake instead of producing a thin
// offline brief.

import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync, existsSync, unlinkSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";

import { appDir } from "../server/lib/env.mjs";
import { loadDossier, validateDossier, localDateString } from "../server/lib/dossier.mjs";

const prefetchDir = dirname(fileURLToPath(import.meta.url));
// Where the brain runs: point this at the directory whose MCP config and
// context files the brain should see (e.g. your notes repo). Defaults to the app.
const brainCwd = process.env.DAYBREAK_BRAIN_CWD || appDir;
const stateDir = process.env.DAYBREAK_STATE || join(appDir, "state");
mkdirSync(join(stateDir, "logs"), { recursive: true });

const paths = {
  dossier: join(stateDir, "dossier.json"),
  pending: join(stateDir, "dossier.pending.json"),
  prompt: process.env.DAYBREAK_PROMPT || join(prefetchDir, "dossier-prompt.md"),
  composedPrompt: join(stateDir, "prefetch-prompt.txt"),
  fixture: join(appDir, "fixtures", "dossier-fixture.json"),
  log: join(stateDir, "logs", "prefetch.jsonl"),
  claudeLog: join(stateDir, "logs", `prefetch-claude-${localDateString()}.log`),
};

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const FIXTURE = args.includes("--fixture") || process.env.DAYBREAK_HARNESS === "fixture";
const timeoutMin = Number(args[args.indexOf("--timeout-min") + 1]) || 25;

function log(event, extra = {}) {
  const entry = { ts: new Date().toISOString(), event, ...extra };
  appendFileSync(paths.log, JSON.stringify(entry) + "\n");
  console.log(`[prefetch] ${event}`, Object.keys(extra).length ? JSON.stringify(extra) : "");
}

// Diction check on the delivered script. Deliberately NON-blocking: a stray
// "actually" is a bad word choice, a missing brief is a missing morning, and
// the validator's job is "is this a real brief". This only surfaces whether the
// prompt's banned-word rules are holding — if these keep appearing, the prompt
// needs work, not the dossier rejecting. Mirrors the list in dossier-prompt.md.
const BANNED_DICTION = [
  /\bload-bearing\b/i, /\bleverage[sd]?\b/i, /\brobust\b/i, /\bseamless(ly)?\b/i,
  /\bdelve[sd]?\b/i, /\bmoreover\b/i, /\bfurthermore\b/i, /\brides?\s+on\b/i,
  /\blocked\s+in\b/i, /\bactually\b/i, /\breally\b/i,
  /\btruly\b/i, /\bhonestly\b/i, /\bgenuinely\b/i,
];
function dictionFlags(script) {
  const hits = [];
  for (const re of BANNED_DICTION) {
    const m = String(script || "").match(re);
    if (m) hits.push(m[0].toLowerCase());
  }
  return hits;
}

function installPending(expectedDate) {
  const raw = readFileSync(paths.pending, "utf8");
  const dossier = JSON.parse(raw);
  const { valid, problems } = validateDossier(dossier, { today: expectedDate });
  if (!valid) {
    log("dossier_rejected", { problems });
    return false;
  }
  const flags = dictionFlags(dossier.briefScript);
  if (flags.length) log("diction_flags", { words: flags });
  renameSync(paths.pending, paths.dossier); // atomic on same volume
  log("dossier_installed", { date: dossier.date, headline: dossier.headline, chars: dossier.briefScript.length });
  return true;
}

// The morning this brief will be delivered. Runs before 15:00 brief today — a
// laptop that stays closed until early afternoon still gets a same-day catch-up
// instead of silent nothing. Later runs pre-gather for tomorrow — the brain
// kept inferring this on its own, so make it explicit instead of punishing it.
function targetMorning() {
  const now = new Date();
  if (now.getHours() < 15) return localDateString(now);
  const t = new Date(now);
  t.setDate(t.getDate() + 1);
  return localDateString(t);
}
const TARGET_DATE = targetMorning();

// ---------- early exit: target morning's dossier already valid & fresh ----------
// A fixture-generated dossier never blocks a real gather — otherwise a harness
// test the night before would silently become the morning's brief. And an
// evening pre-gather never blocks the 06:55 run: >6h old means overnight
// Slack/email is missing, so re-gather (the old dossier stays installed as the
// fallback if the new run fails).
const existing = loadDossier(paths.dossier);
const existingIsFixture = /fixture/i.test(existing.dossier?.generatedBy || "");
// freshness from file mtime, not dossier.generatedAt — the brain fabricates
// timestamps (round 2 wrote "02:15 tomorrow" at 20:10), mtime can't lie
const ageMs = Date.now() - (existing.mtime || 0);
const existingIsFresh = ageMs < 6 * 60 * 60_000;
const existingIsForTarget = existing.dossier?.date === TARGET_DATE;
if (existing.exists && existingIsForTarget && !existingIsFixture && existingIsFresh && !FORCE && !FIXTURE) {
  const { valid } = validateDossier(existing.dossier, { today: TARGET_DATE });
  if (valid) {
    log("skip_already_valid", { generatedAt: existing.dossier.generatedAt });
    process.exit(0);
  }
}

// ---------- deferral: battery + closed lid cannot gather ----------
// Proven live 2026-09-15: on battery with the lid closed macOS force-sleeps ~1s
// after the caffeinate assertions are created ("Sleep Service Back to Sleep"),
// the gather runs in 2-24s dark-wake slivers, and every network MCP call dies —
// 103 wall-clock minutes produced a thin GitHub-only brief. Running here is
// worse than not running: the thin dossier installs, passes validation, and
// blocks the real gather all morning. So refuse (exit 3) and let launchd's next
// fire or the server watchdog retry; at first real wake the condition clears,
// the gather runs, and the late-ring grace in ring.mjs places the call — the
// unplugged half of the spec: sync once woken, THEN send. AC is exempt (pmset
// keeps an AC Mac awake even lid-closed, e.g. docked with the lid down), and
// lid-open battery is exempt (caffeinate -i holds there). Sits after the early
// exit because a valid dossier needs no gather on any power source, and before
// the lock because a sub-second refusal shouldn't churn it.
function powerAndLid() {
  // Harness override: DAYBREAK_ASSUME="battery,closed" fakes the readings so
  // this path is testable on a docked machine.
  const fake = process.env.DAYBREAK_ASSUME;
  if (fake) {
    const [power, lid] = fake.split(",");
    return { power, lidClosed: lid === "closed" };
  }
  let power = null;
  let lidClosed = false;
  try {
    const batt = execFileSync("/usr/bin/pmset", ["-g", "batt"], { encoding: "utf8", timeout: 5_000 });
    if (/AC Power/.test(batt)) power = "AC";
    else if (/Battery Power/.test(batt)) power = "battery";
  } catch {}
  try {
    const io = execFileSync("/usr/sbin/ioreg", ["-r", "-k", "AppleClamshellState", "-d", "4"], { encoding: "utf8", timeout: 5_000 });
    lidClosed = /"AppleClamshellState"\s*=\s*Yes/.test(io);
  } catch {}
  // Defer only on an affirmative battery reading: a failed or unparseable
  // pmset must never cost a morning, so unknown power proceeds.
  return { power, lidClosed };
}
if (!FORCE && !FIXTURE) {
  const { power, lidClosed } = powerAndLid();
  if (power === "battery" && lidClosed) {
    log("gather_deferred", { power, lidClosed, target: TARGET_DATE });
    process.exit(3);
  }
}

// ---------- single-flight lock ----------
// launchd (06:55 + 07:25 backstop, plus wake-time catch-up fires) and the
// server's watchdog can all reach this point; a gather runs ~5 min and up to
// timeoutMin. First one in wins, everyone else exits.
//
// Steal on PID liveness, NOT on wall-clock age. The old rule ("older than 30
// min is a crashed run") measured wall clock, which says nothing about progress
// across system sleep: on 2026-08-25 a frozen-but-alive gather held the lock
// while 30 wall-clock minutes passed with zero CPU granted, so two later runs
// each declared it stale and stole it. Three concurrent `claude` processes ended
// up racing for the same dossier. A live holder now keeps the lock however long
// the machine keeps it frozen; only a genuinely dead PID gets displaced.
const lockPath = join(stateDir, "prefetch.lock");

function lockHolderAlive() {
  let pid;
  try {
    pid = Number(readFileSync(lockPath, "utf8").trim().split("\n")[0]);
  } catch {
    return false; // unreadable lock: treat as abandoned
  }
  if (!Number.isInteger(pid) || pid <= 1) return false; // malformed: abandoned
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0); // signal 0 probes existence without delivering
    return true;
  } catch (err) {
    // ESRCH = no such process (dead, steal it). EPERM = alive under another
    // uid, which still means someone holds it.
    return err?.code === "EPERM";
  }
}

function acquireLock() {
  try {
    writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
    return true;
  } catch {
    try {
      // Backstop for PID reuse: a lock this old whose PID now maps to some
      // unrelated process would otherwise wedge the gather forever. Far beyond
      // any real gather (timeoutMin is 25) so it never races a live run.
      const ageMs = Date.now() - statSync(lockPath).mtimeMs;
      if (!lockHolderAlive() || ageMs > 6 * 60 * 60_000) {
        unlinkSync(lockPath);
        writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
        return true;
      }
    } catch {}
    return false;
  }
}
if (!acquireLock()) {
  log("skip_locked", { holderAlive: true });
  process.exit(0);
}
process.on("exit", () => {
  try { unlinkSync(lockPath); } catch {}
});

// ---------- harness mode: fixture re-dated to today ----------
if (FIXTURE) {
  const fixture = JSON.parse(readFileSync(paths.fixture, "utf8"));
  fixture.date = localDateString();
  fixture.generatedAt = new Date().toISOString();
  fixture.generatedBy = "fixture (DAYBREAK_HARNESS)";
  writeFileSync(paths.pending, JSON.stringify(fixture, null, 2));
  process.exit(installPending(localDateString()) ? 0 : 1);
}

// ---------- real run: the brain with the dossier prompt ----------
const promptBody = readFileSync(paths.prompt, "utf8");

// Continuity: the brain sees what the last brief already told the user, so
// mornings don't repeat each other. Best-effort — any problem means no block.
function previousBriefBlock() {
  try {
    const prev = JSON.parse(readFileSync(paths.dossier, "utf8"));
    if (!prev?.briefScript || !prev?.date) return "";
    const script = prev.briefScript.length > 1500 ? prev.briefScript.slice(0, 1500) + " …" : prev.briefScript;
    return `\n## Previously briefed (${prev.date}) — old news, brief only the deltas\n\nHeadline: ${prev.headline}\n\n${script}\n`;
  } catch {
    return "";
  }
}

// Reader feedback: comments the user left on brief paragraphs in the handset
// (POST /api/feedback → brief-feedback.jsonl). Standing instructions — recent
// entries ride along every morning so the brief improves daily.
function feedbackBlock() {
  try {
    const raw = readFileSync(join(stateDir, "brief-feedback.jsonl"), "utf8").trim();
    if (!raw) return "";
    const cutoff = Date.now() - 21 * 24 * 60 * 60_000;
    const entries = raw
      .split("\n")
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((e) => e?.comment && Date.parse(e.ts) > cutoff)
      .slice(-30);
    if (!entries.length) return "";
    const rendered = entries
      .map((e) => `- [${e.briefDate}] on "${(e.paragraphText || "the brief").slice(0, 100)}": ${e.comment}`)
      .join("\n");
    return `\n## Reader feedback on past briefs (standing instructions, newest last)\n\n${rendered}\n`;
  } catch {
    return "";
  }
}
// Same-day gathers after 10:00 mean the ring window is gone and half the day
// happened — a "good morning, here's your day ahead" script would be wrong.
const middayCatchUp = TARGET_DATE === localDateString() && new Date().getHours() >= 10;
const middayNote = middayCatchUp
  ? `\nOverride the morning framing: it is already ${new Date().toTimeString().slice(0, 5)} on the target day.
Write the briefScript as a midday catch-up instead — no "good morning" open, lead with what is
left of today (remaining meetings, deadlines still live), and compress everything already past
into a single "while you were out" line.\n`
  : "";
const composed = `${promptBody}

---

Today is ${localDateString()} and the current time is ${new Date().toTimeString().slice(0, 5)} local.
This dossier is for the morning of ${TARGET_DATE}. Set "date" to exactly "${TARGET_DATE}",
set "generatedAt" to the actual current timestamp (now, not a made-up morning time), and write
every "today" in the briefScript from the perspective of that morning.
${middayNote}${previousBriefBlock()}${feedbackBlock()}
Write the dossier to exactly this path: ${paths.pending}
`;
writeFileSync(paths.composedPrompt, composed);
try { unlinkSync(paths.pending); } catch {}

// The brain reads the composed prompt on stdin and must write the dossier to
// the path named on its last line. Default: headless Claude Code with the
// model pinned (an unpinned CLI default can drift to a model your account or
// gateway doesn't serve, and the run dies in seconds).
// --dangerously-skip-permissions: headless job on your own machine; the
// prompt scopes the run to read-only gathering + one file write.
const model = process.env.DAYBREAK_PREFETCH_MODEL || "sonnet";
const brainCmd =
  process.env.DAYBREAK_BRAIN_CMD ||
  `claude -p --dangerously-skip-permissions --model ${JSON.stringify(model)}`;
// -l shell so launchd gets the user's PATH (claude bin, node, etc).
const cmd = [
  `cd ${JSON.stringify(brainCwd)}`,
  `${brainCmd} < ${JSON.stringify(paths.composedPrompt)}`,
].join(" && ");

log("claude_start", { cmd: brainCmd, timeoutMin, cwd: brainCwd });
const t0 = Date.now();
// detached: child leads its own process group, so the timeout can kill the
// whole tree (zsh → claude → MCP servers). SIGTERM to just the zsh wrapper
// left claude alive holding the pipes — one run zombied for ~70h (2026-08-15).
// caffeinate: a gather needs 3-5 min of continuous CPU. On 2026-08-24 the Mac
// slept on battery through the whole ring window, granting only 2-15s dark-wake
// slices — the 25-min killer stretched to 118 min of wall clock and all three
// attempts died with nothing written. -i holds off idle sleep on battery too
// (-s alone is AC-only); the assertion lives exactly as long as the child.
// Pairs with `sudo pmset repeat wakeorpoweron MTWRF 06:50:00`, which supplies
// the real FullWake this then holds open.
// env: .env values were merged into process.env by env.mjs, so anything the
// brain needs headless (API keys, feature flags) can live there — `zsh -lc`
// (login, non-interactive) never reads ~/.zshrc.
const child = spawn("/usr/bin/caffeinate", ["-i", "-m", "-s", "/bin/zsh", "-lc", cmd], {
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
  env: process.env,
});

const claudeLog = [];
child.stdout.on("data", (d) => claudeLog.push(d));
child.stderr.on("data", (d) => claudeLog.push(d));

function killTree(signal) {
  try { process.kill(-child.pid, signal); } catch {}
}
const killer = setTimeout(() => {
  log("claude_timeout", { afterMin: timeoutMin });
  killTree("SIGTERM");
  setTimeout(() => killTree("SIGKILL"), 10_000).unref();
}, timeoutMin * 60_000);

child.on("close", (code) => {
  clearTimeout(killer);
  // Append, never truncate: this file used to be overwritten by every run, so
  // on a multi-attempt morning only the LAST run's output survived and the
  // failures that actually mattered were undiagnosable (2026-08-24).
  try {
    const header = `\n===== run ${new Date().toISOString()} exit=${code} ms=${Date.now() - t0} =====\n`;
    appendFileSync(paths.claudeLog, header + Buffer.concat(claudeLog).toString("utf8"));
  } catch {}
  const ms = Date.now() - t0;
  if (!existsSync(paths.pending)) {
    log("no_dossier_written", { code, ms });
    process.exit(1);
  }
  try {
    const ok = installPending(TARGET_DATE);
    log("claude_done", { code, ms, installed: ok });
    process.exit(ok ? 0 : 1);
  } catch (err) {
    log("install_error", { error: String(err) });
    process.exit(1);
  }
});
