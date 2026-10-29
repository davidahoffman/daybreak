// Pause Spotify while the user is on a call; resume when they hang up.
//
// "Joined a Google Meet" is detected as "some process is using the default
// mic" (mic-watch/, CoreAudio IsRunningSomewhere). Meet holds the mic from join
// to leave, and the signal needs no browser automation or tab-URL guessing —
// Meet's post-call "You left the meeting" page keeps the same URL, so tab
// watching would never resume. Huddles and Zoom come along for free.
//
// Debounced both ways: a mic must stay on ONSEC before we pause (dictation
// blips, AirPods renegotiation) and off OFFSEC before we resume (device
// switches mid-call). Resumes only what this watcher itself paused.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { pauseSpotify, resumeSpotify } from "./spotify.mjs";

const dir = join(dirname(dirname(fileURLToPath(import.meta.url))), "mic-watch");
const src = join(dir, "main.swift");
const bin = join(dir, "mic-watch");
const ONSEC = 3;
const OFFSEC = 10;

function ensureBuilt() {
  if (existsSync(bin) && statSync(bin).mtimeMs >= statSync(src).mtimeMs) return;
  execFileSync("/usr/bin/swiftc", ["-O", "-o", bin, src], { timeout: 180_000 });
}

export function startMicWatch({ log }) {
  let pausedBy = null; // {deviceId} when this watcher paused Spotify
  let timer = null;

  const onMicOn = async () => {
    const r = await pauseSpotify();
    log("mic_spotify_pause", r);
    if (r.result === "paused") pausedBy = { deviceId: r.deviceId };
  };
  const onMicOff = async () => {
    if (!pausedBy) return;
    const { deviceId } = pausedBy;
    pausedBy = null;
    log("mic_spotify_resume", { result: await resumeSpotify(deviceId) });
  };

  const run = () => {
    try {
      ensureBuilt();
    } catch (e) {
      log("mic_watch_build_error", { error: String(e.message || e).slice(0, 300) });
      return;
    }
    const child = spawn(bin, [], { stdio: ["ignore", "pipe", "ignore"] });
    createInterface({ input: child.stdout }).on("line", (line) => {
      const state = line.trim();
      if (state !== "on" && state !== "off") return;
      clearTimeout(timer);
      timer = setTimeout(state === "on" ? onMicOn : onMicOff, (state === "on" ? ONSEC : OFFSEC) * 1000);
      timer.unref?.();
    });
    child.on("exit", (code) => {
      log("mic_watch_exit", { code });
      setTimeout(run, 30_000).unref?.();
    });
    log("mic_watch_started", { pid: child.pid });
  };
  run();
}
