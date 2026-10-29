// Pause Spotify before the brief plays — on whatever device is playing.
//
// Many people listen in the browser (open.spotify.com), which the desktop-app
// AppleScript can't reach. The Web API's PUT /v1/me/player/pause targets the
// account's active device, so one call covers the web player, the desktop app,
// and the phone. Requires Spotify Premium (player endpoints 403 otherwise).
//
// Auth: Authorization Code + PKCE, so no client secret exists anywhere.
// scripts/spotify-auth.mjs does the one-time browser login and writes
// state/spotify-token.json {clientId, refreshToken} (0600, state/ is gitignored).
// PKCE refresh tokens rotate: every refresh may return a new one, which we
// persist immediately or the next morning's refresh fails.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const libDir = dirname(fileURLToPath(import.meta.url));
const appDir = dirname(dirname(libDir)); // apps/daybreak
const stateDir = process.env.DAYBREAK_STATE || join(appDir, "state");
export const tokenFile = join(stateDir, "spotify-token.json");

let cached = { accessToken: null, expiresAt: 0 };

function readCreds() {
  try {
    return JSON.parse(readFileSync(tokenFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveCreds(creds) {
  writeFileSync(tokenFile, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
}

async function accessToken(creds) {
  if (cached.accessToken && Date.now() < cached.expiresAt - 60_000) return cached.accessToken;
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: creds.refreshToken,
      client_id: creds.clientId,
    }),
    signal: AbortSignal.timeout(5_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`token refresh ${r.status}: ${j.error_description || j.error || "unknown"}`);
  if (j.refresh_token && j.refresh_token !== creds.refreshToken) saveCreds({ ...creds, refreshToken: j.refresh_token });
  cached = { accessToken: j.access_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000 };
  return cached.accessToken;
}

async function api(creds, method, path) {
  const token = await accessToken(creds);
  return fetch(`https://api.spotify.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
}

// Pause only if something is actually playing, and remember which device, so
// resume never starts music the user had already stopped. Resolves to
// {result, deviceId?}; never throws — music is a nicety, the brief isn't.
export async function pauseSpotify() {
  const creds = readCreds();
  if (!creds?.refreshToken || !creds?.clientId) return { result: "not_configured" };
  try {
    const now = await api(creds, "GET", "/me/player");
    if (now.status === 204) return { result: "no_active_device" };
    const player = await now.json().catch(() => ({}));
    if (!player.is_playing) return { result: "not_playing" };
    const r = await api(creds, "PUT", "/me/player/pause");
    if (r.status === 204 || r.status === 200) return { result: "paused", deviceId: player.device?.id || null };
    const j = await r.json().catch(() => ({}));
    return { result: `http_${r.status}${j.error?.reason ? ":" + j.error.reason : ""}` };
  } catch (e) {
    return { result: "error:" + String(e.message || e).slice(0, 160) };
  }
}

// Resume on the device we paused (device_id keeps it from jumping to the phone).
export async function resumeSpotify(deviceId) {
  const creds = readCreds();
  if (!creds?.refreshToken || !creds?.clientId) return "not_configured";
  try {
    const q = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
    const r = await api(creds, "PUT", `/me/player/play${q}`);
    if (r.status === 204 || r.status === 200) return "resumed";
    const j = await r.json().catch(() => ({}));
    return `http_${r.status}${j.error?.reason ? ":" + j.error.reason : ""}`;
  } catch (e) {
    return "error:" + String(e.message || e).slice(0, 160);
  }
}
