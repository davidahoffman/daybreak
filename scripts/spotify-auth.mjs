#!/usr/bin/env node
// One-time Spotify login for the pause-on-answer feature (server/lib/spotify.mjs).
//
// Setup: create an app at https://developer.spotify.com/dashboard, check
// "Web API", add redirect URI http://127.0.0.1:8888/callback exactly
// (Spotify rejects "localhost"), then:
//   node scripts/spotify-auth.mjs <client-id>
// Opens the browser, catches the redirect, writes state/spotify-token.json.

import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { saveCreds, tokenFile } from "../server/lib/spotify.mjs";

const clientId = process.argv[2];
if (!clientId) {
  console.error("usage: node scripts/spotify-auth.mjs <client-id>");
  process.exit(1);
}
const redirectUri = "http://127.0.0.1:8888/callback";
const verifier = randomBytes(48).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const stateParam = randomBytes(12).toString("hex");

const authUrl =
  "https://accounts.spotify.com/authorize?" +
  new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: "user-modify-playback-state user-read-playback-state",
    code_challenge_method: "S256",
    code_challenge: challenge,
    state: stateParam,
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  if (url.pathname !== "/callback") return res.writeHead(404).end();
  const code = url.searchParams.get("code");
  const fail = (msg) => {
    res.writeHead(400, { "Content-Type": "text/plain" }).end(msg);
    console.error(msg);
    server.close();
    process.exitCode = 1;
  };
  if (url.searchParams.get("state") !== stateParam) return fail("state mismatch");
  if (!code) return fail("no code: " + (url.searchParams.get("error") || "unknown"));
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.refresh_token) return fail(`token exchange ${r.status}: ${j.error_description || j.error}`);
  saveCreds({ clientId, refreshToken: j.refresh_token });
  res.writeHead(200, { "Content-Type": "text/plain" }).end("Daybreak is connected to Spotify. You can close this tab.");
  console.log("saved", tokenFile);
  server.close();
});

server.listen(8888, "127.0.0.1", () => {
  console.log("opening", authUrl);
  execFile("/usr/bin/open", [authUrl]);
});
