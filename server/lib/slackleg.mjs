// Slack voicemail leg — uploads the rendered brief.wav UNSHARED (no channel
// message) and hands its permalink + transcript to the workflow notify, which
// is the single message the user sees. Delivery insurance for mornings when
// the phone can't reach the Mac (hotel Wi-Fi client isolation, different
// network). The call is the product; this is the leg that always arrives.
//
// Why unshared, and why the permalink is a bare link (all three options tried
// live): sharing the upload to a channel posts a second, duplicate message.
// The workflow message only unfurls an inline audio player for a file already
// shared TO THAT CHANNEL — the workflow bot can't attach a file it can't see.
// So the inline player and the single message are mutually exclusive. The
// permalink opens Slack's file viewer with the player — one tap.
//
// Same trust rules as the ring: only a validated dossier's brief is ever
// posted, and the success marker is written only after Slack confirms — so the
// server's interval retries the whole flow until it lands.
//
//   node lib/slackleg.mjs --now    post immediately (still requires valid dossier + brief.wav)
//
// Auth: SLACK_BOT_TOKEN (xoxb, scopes files:write + files:read) from the
// environment or daybreak/.env. Enable with "slackLeg": true in state/config.json.

import "./env.mjs";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { notify } from "./notify.mjs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appDir } from "./env.mjs";

function slackCreds() {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN not in env or .env");
  return { token };
}

async function slackApi(method, { token }, body, isJson = false) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": isJson ? "application/json; charset=utf-8" : "application/x-www-form-urlencoded",
    },
    body: isJson ? JSON.stringify(body) : new URLSearchParams(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.error || res.status}`);
  return data;
}

export function markerPath(stateDir, date) {
  return join(stateDir, `slack-leg-${date}.json`);
}

export async function postBriefToSlack({ wavPath, dossier, log = () => {} }) {
  const creds = slackCreds();
  const wav = readFileSync(wavPath);
  const filename = `daybreak-brief-${dossier.date}.wav`;

  const { upload_url, file_id } = await slackApi("files.getUploadURLExternal", creds, {
    filename,
    length: String(wav.length),
  });

  const up = await fetch(upload_url, {
    method: "POST",
    body: wav,
    headers: { "Content-Type": "audio/wav" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!up.ok) throw new Error(`upload_url POST ${up.status}`);

  // No channel_id/initial_comment: the upload stays unshared, so the only
  // channel message is the workflow notify (which carries the transcript).
  // See header for why the permalink can't unfurl a player without a share.
  await slackApi(
    "files.completeUploadExternal",
    creds,
    { files: [{ id: file_id, title: `Daybreak brief — ${dossier.date}` }] },
    true
  );

  // Permalink for the push leg. files.info works even on Enterprise Grid
  // workspaces where chat.getPermalink is restricted.
  let permalink = "";
  try {
    const info = await slackApi("files.info", creds, { file: file_id });
    permalink = info.file?.permalink || "";
  } catch (err) {
    log("slack_leg_permalink_failed", { error: String(err) });
  }

  log("slack_leg_posted", { date: dossier.date, bytes: wav.length, fileId: file_id, shared: false, permalink });

  return { fileId: file_id, permalink };
}

// Interval gate for the server: post once per dossier date, at/after postAt,
// only when the same conditions that arm the ring hold (valid + rendered).
export async function slackLegIfNeeded({ config, dossierState, briefAudioReady, stateDir, wavPath, log }) {
  if (!config.slackLeg) return;
  if (!dossierState.valid || !briefAudioReady) return;
  const date = dossierState.dossier.date;
  const marker = markerPath(stateDir, date);
  if (existsSync(marker)) return;

  const postAt = config.slackPostTime || "07:40";
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  if (hhmm < postAt) return;

  const { fileId, permalink } = await postBriefToSlack({ wavPath, dossier: dossierState.dossier, log });
  writeFileSync(marker, JSON.stringify({ postedAt: new Date().toISOString(), fileId, permalink }, null, 2));

  // The upload above is silent. This is the one message the user sees — it
  // arrives as the Workflow app, so it pushes. The transcript rides along
  // because Slack's built-in transcription mangles it ("sends" → "cents") and
  // we hold the canonical text.
  await notify({
    headline: dossierState.dossier.headline,
    quote: dossierState.dossier.briefScript,
    permalink,
    log,
  });
}

// ---------- CLI: node lib/slackleg.mjs --now ----------
// Mirrors the production flow (unshared upload + workflow notify) so one run
// verifies the whole single-message path. Skips the marker, so it WILL post a
// real notify message even if today's already went out.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stateDir = process.env.DAYBREAK_STATE || join(appDir, "state");
  const wavPath = join(stateDir, "brief.wav");
  const dossier = JSON.parse(readFileSync(join(stateDir, "dossier.json"), "utf8"));
  if (!existsSync(wavPath)) throw new Error("no brief.wav rendered");
  const clog = (e, x) => console.log(`[slackleg] ${e}`, x ?? "");
  console.log(`[slackleg] uploading brief for ${dossier.date} (${statSync(wavPath).size} bytes, unshared)…`);
  try {
    const { permalink } = await postBriefToSlack({ wavPath, dossier, log: clog });
    await notify({ headline: dossier.headline, quote: dossier.briefScript, permalink, log: clog });
    console.log("[slackleg] done");
  } catch (err) {
    console.error(`[slackleg] failed: ${err.message}`);
    process.exit(1);
  }
}
