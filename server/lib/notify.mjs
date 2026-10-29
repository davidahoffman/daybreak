// Push leg — the only path that can actually interrupt the user.
//
// Everything else Daybreak does is silent by construction:
//   - the Slack voicemail leg (slackleg.mjs) uploads the brief file, and a
//     Slack upload never pushes on its own.
//   - Slackbot reminders can land silently (no push, no badge) on some
//     workspaces.
//   - ring() needs the Mac awake with the user at it.
//
// So this posts through a webhook — designed for a Slack Workflow Builder
// webhook trigger. The message arrives as the Workflow app rather than as the
// user, which is what makes an @-mention of yourself actually push. Workflow
// Builder needs no custom Slack app. Any endpoint that accepts the same JSON
// works (a Zapier hook, ntfy, your own relay).
//
// Trigger contract: POST application/json {"headline": "...", "permalink": "..."}
// Build the workflow as: "Send a message to <channel>: @you {headline}{permalink}".
//
// Auth: DAYBREAK_SLACK_WEBHOOK from the environment or daybreak/.env. The URL
// is bearer-grade: anyone holding it can post as the workflow, so keep it in
// the gitignored .env.

import "./env.mjs";
import { fileURLToPath } from "node:url";

export function webhookUrl() {
  return process.env.DAYBREAK_SLACK_WEBHOOK || null;
}

// The workflow template joins headline and permalink with no separator (the
// Workflow composer wipes the field on injected keystrokes, so the space never
// landed and re-editing it by automation isn't worth the fight). Prefixing the
// newline here puts the link on its own line and keeps the template untouched.
//
// The template has exactly these two fields, so the transcript quote is packed
// into the permalink field: headline stays field 1; field 2 becomes
// "\nquote…\n\npermalink". Plain text only — Workflow variables don't parse
// mrkdwn ("> " blockquote prefixes arrive as literal ">" chars).
export async function notify({ headline, quote = "", permalink = "", log = () => {} }) {
  const url = webhookUrl();
  if (!url) {
    log("notify_skipped", { reason: "no DAYBREAK_SLACK_WEBHOOK in env or .env" });
    return false;
  }
  const quoted = String(quote || "").trim();
  const body = JSON.stringify({
    headline: String(headline || "").trim(),
    permalink: [
      quoted ? `\n${quoted}` : "",
      permalink ? `\n\n${permalink}` : "",
    ].join(""),
  });
  // One retry: the webhook is a single wake-edge POST, and a freshly woken
  // Mac's network often fails the first request (TimeoutError, "fetch failed").
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      const text = (await res.text()).slice(0, 200);
      if (!res.ok) {
        log("notify_failed", { status: res.status, body: text, attempt });
      } else {
        log("notify_sent", { chars: body.length, attempt });
        return true;
      }
    } catch (err) {
      log("notify_failed", { error: String(err), attempt });
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 3_000));
  }
  return false;
}

// ---------- CLI: node lib/notify.mjs "headline" [permalink] [quote] ----------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , headline, permalink, quote] = process.argv;
  if (!headline) {
    console.error('usage: node lib/notify.mjs "headline text" [permalink] [quote]');
    process.exit(1);
  }
  const ok = await notify({
    headline,
    permalink: permalink || "",
    quote: quote || "",
    log: (e, x) => console.log(`[notify] ${e}`, x ? JSON.stringify(x) : ""),
  });
  process.exit(ok ? 0 : 1);
}
