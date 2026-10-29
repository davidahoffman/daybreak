// Loads daybreak/.env into process.env (never overriding real env vars).
// launchd jobs get no interactive-shell env, so keys live in the gitignored
// .env next to the app rather than in ~/.zshrc. Import for its side effect.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const appDir = dirname(dirname(dirname(fileURLToPath(import.meta.url)))); // daybreak/

// Accepts both bare KEY=VALUE and `export KEY=VALUE` lines.
export function parseEnvFile(path) {
  const values = {};
  try {
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      let line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("export ")) line = line.slice(7).trim();
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const k = line.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
      values[k] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch {}
  return values;
}

const envPath = process.env.DAYBREAK_ENV || join(appDir, ".env");
for (const [k, v] of Object.entries(parseEnvFile(envPath))) {
  if (process.env[k] === undefined) process.env[k] = v;
}
