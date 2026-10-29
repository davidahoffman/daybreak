// Ring scheduler — arms only when today's dossier is valid AND the brief
// audio is pre-rendered (answer must be instant). Unanswered rings retry
// every retryMinutes until the deadline. Shelly lineage: pre-summarize-then-
// ring + 20-minute morning retries, minus the parts that made it ring with
// nothing to say.

import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { localDateString } from "./dossier.mjs";

function parseHHMM(s, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || "");
  if (!m) return fallback;
  return { h: Number(m[1]), m: Number(m[2]) };
}

export class RingScheduler {
  constructor({ config, statusFn, ringStatePath, token, log = () => {} }) {
    this.config = config;
    this.statusFn = statusFn; // () => ({ dossierValid, briefAudioReady })
    this.ringStatePath = ringStatePath;
    this.token = token;
    this.log = log;
    this.state = this.loadState();
    this.timer = null;
  }

  loadState() {
    try {
      const s = JSON.parse(readFileSync(this.ringStatePath, "utf8"));
      if (s.date === localDateString()) return s;
    } catch {}
    return { date: localDateString(), ringCount: 0, lastRingAt: null, answeredAt: null, openedUI: false };
  }

  saveState() {
    writeFileSync(this.ringStatePath, JSON.stringify(this.state, null, 2));
  }

  rolloverIfNewDay() {
    if (this.state.date !== localDateString()) {
      this.state = { date: localDateString(), ringCount: 0, lastRingAt: null, answeredAt: null, openedUI: false };
      this.saveState();
    }
  }

  markAnswered() {
    this.rolloverIfNewDay();
    if (!this.state.answeredAt) {
      this.state.answeredAt = new Date().toISOString();
      this.saveState();
      this.log("call_answered", {});
    }
  }

  todayAt({ h, m }) {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
  }

  shouldRing(now = new Date()) {
    this.rolloverIfNewDay();
    const cfg = this.config();
    if (cfg.weekdaysOnly && (now.getDay() === 0 || now.getDay() === 6)) return { ring: false, why: "weekend" };
    const ringAt = this.todayAt(parseHHMM(cfg.ringTime, { h: 7, m: 45 }));
    const deadline = this.todayAt(parseHHMM(cfg.ringDeadline, { h: 9, m: 30 }));
    if (now < ringAt) return { ring: false, why: "before ring time", ringAt };
    if (now > deadline) {
      // Late-open grace: a laptop opened after the deadline still gets ONE
      // ring once the brief lands (2026-09-14: dossier valid at 10:04, Slack
      // leg posted, but the tab — which only opens inside ring() — never did).
      // ringCount > 0 blocks retries; 15:00 matches the prefetch watchdog's
      // gather window — past that, the next brief is tomorrow's.
      const lateCutoff = this.todayAt({ h: 15, m: 0 });
      if (now > lateCutoff || this.state.ringCount > 0 || this.state.answeredAt)
        return { ring: false, why: "past deadline", ringAt };
      const { dossierValid, briefAudioReady } = this.statusFn();
      if (!dossierValid || !briefAudioReady)
        return { ring: false, why: "past deadline (no brief ready for a late ring)", ringAt };
      return { ring: true, ringAt, late: true };
    }
    if (this.state.answeredAt) return { ring: false, why: "already answered", ringAt };
    const { dossierValid, briefAudioReady } = this.statusFn();
    if (!dossierValid) return { ring: false, why: "no valid dossier — no ring without a real brief", ringAt };
    if (!briefAudioReady) return { ring: false, why: "brief audio not rendered yet", ringAt };
    const retryMs = (cfg.retryMinutes ?? 20) * 60_000;
    if (this.state.lastRingAt && now - new Date(this.state.lastRingAt) < retryMs)
      return { ring: false, why: "waiting for retry window", ringAt };
    return { ring: true, ringAt };
  }

  start() {
    this.timer = setInterval(() => {
      const verdict = this.shouldRing();
      if (verdict.ring) this.ring({ late: !!verdict.late });
    }, 30_000);
    this.timer.unref?.();
  }

  ring({ force = false, late = false } = {}) {
    this.rolloverIfNewDay();
    this.state.ringCount += 1;
    this.state.lastRingAt = new Date().toISOString();
    const firstRingToday = !this.state.openedUI;
    if (firstRingToday) this.state.openedUI = true;
    this.saveState();
    this.log("ring", { count: this.state.ringCount, force, late });

    const cfg = this.config();
    const url = `http://localhost:${cfg.port}/call?ring=1&t=${this.token()}`;

    // Ring sound: Glass ×4 with a gap — audible without being an alarm.
    let plays = 0;
    const playOnce = () => {
      spawn("afplay", ["/System/Library/Sounds/Glass.aiff"], { stdio: "ignore" }).unref();
      plays += 1;
      if (plays < 4) setTimeout(playOnce, 1200);
    };
    playOnce();

    // First ring of the day opens the call page; retries just chime + notify.
    if (firstRingToday || force) {
      spawn("open", [url], { stdio: "ignore" }).unref();
    } else {
      const script = `display notification "Daybreak is calling — your morning brief is ready" with title "Daybreak" sound name "Glass"`;
      spawn("osascript", ["-e", script], { stdio: "ignore" }).unref();
    }
  }
}
