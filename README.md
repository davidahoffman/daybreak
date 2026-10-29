# Daybreak

A morning call from a chief of staff who read everything overnight. An AI agent gathers your day before you wake up (calendar, Slack, email, project status), writes one structured dossier, and at 07:45 your phone rings. You answer, hear a short spoken brief, and talk back: ask what someone said, dig into a thread, queue a follow-up. Then you hang up and start the day caught up.

It runs on your Mac. Built with Claude Code.

## How it works

Daybreak has three parts. The seams between them are the point:

- **A brain** writes `state/dossier.json`. By default it's headless Claude Code (`claude -p`), using whatever MCP servers and files you give it. `prefetch/dossier-prompt.md` is the whole contract, so Codex, a script, or a person could fill the role instead. The server never trusts the brain: a dossier that fails validation never rings.
- **The exchange** is a zero-dependency Node server (`server/daybreak-server.mjs`, port 7745). It validates the dossier, pre-renders the brief audio, places the ring, and runs voice turns during the call (OpenAI speech-to-text → Claude with tools → OpenAI text-to-speech).
- **Handsets** are thin clients. `web/call.html` works in any browser on your network. `ios/` is a SwiftUI app that pairs with the server. Both speak the same HTTP protocol.

## Setup

Requirements:

- A Mac with Node 24+ (zero npm dependencies).
- An Anthropic API key and an OpenAI API key.
- For the default brain: [Claude Code](https://claude.com/claude-code) with the MCP servers you want it to read (calendar, Slack, email). Without them it can still brief from local files and the GitHub CLI.

```bash
git clone https://github.com/davidahoffman/daybreak.git
cd daybreak
cp .env.example .env          # add ANTHROPIC_API_KEY and OPENAI_API_KEY
scripts/daybreak.sh fixture   # install the demo dossier
scripts/daybreak.sh install   # start the server + schedule the morning gather
scripts/daybreak.sh ring      # test ring now
```

`install` prints the handset URL (`http://<your-mac>.local:7745/call`). Pair with the token in `state/device-token`.

Then point the brain at your world:

1. Set `DAYBREAK_BRAIN_CWD` in `.env` to the directory whose MCP config and notes the brain should use (your notes repo, for example).
2. Edit the "What to gather" list in `prefetch/dossier-prompt.md` to match your sources. Use `DAYBREAK_PROMPT` to keep your version outside this repo.
3. Run `scripts/daybreak.sh prefetch` to do a real gather now, then `scripts/daybreak.sh status`.

To have the Mac wake itself for the gather, run `sudo pmset repeat wakeorpoweron MTWRF 06:50:00` once.

Settings live in `state/config.json`, created on first run: ring time, deadline, retry interval, voice, chat model, your first name, STT language.

## A morning, minute by minute

| Time (Mac-local) | What happens |
|---|---|
| 06:50 | `pmset` wakes the Mac. launchd runs the prefetch at 06:50, 06:55, and 07:25. Extra runs do nothing once a valid dossier exists |
| ~06:55 | The brain gathers (a few minutes) and writes the dossier. The server validates it and renders `brief.wav` |
| 07:45 | The ring: a chime on the Mac, the call page opens, and the iPhone app sends a local notification. **No valid dossier or no rendered audio means no ring.** |
| Missed? | Re-rings every 20 minutes until 09:30. The brief waits in the handset all day |

## Operating it

```bash
scripts/daybreak.sh status     # server health, dossier validity, ring state
scripts/daybreak.sh install    # (re)install both launchd agents and start the server
scripts/daybreak.sh uninstall  # remove the agents (state/ kept)
scripts/daybreak.sh ring       # test ring right now
scripts/daybreak.sh fixture    # demo dossier (never blocks a real gather)
scripts/daybreak.sh prefetch   # force a real gather now
scripts/daybreak.sh logs       # tail the server log
node scripts/test-web-handset.mjs  # headless-Chrome check of web playback (marks today answered)
```

The launchd agents are `com.daybreak.server` (keep-alive) and `com.daybreak.prefetch`.

## Optional extras

- **Slack voicemail.** When your phone can't reach the Mac (hotel Wi-Fi, another network), the server can upload `brief.wav` to Slack and push you a message with the transcript and a link. Set `"slackLeg": true` in `state/config.json`, then add `SLACK_BOT_TOKEN` (scopes `files:write`, `files:read`) and `DAYBREAK_SLACK_WEBHOOK` to `.env`. For the webhook, create a Slack Workflow Builder workflow with a webhook trigger that takes `headline` and `permalink` and posts `@you {headline}{permalink}` to a channel. It posts as the workflow rather than as you, which is what makes the mention push to your phone. The same webhook powers the in-call `send_link` tool.
- **Spotify pause.** When you answer, Daybreak pauses Spotify on your active device and resumes it when the brief ends. It also pauses whenever another app takes the mic (Meet, Zoom). Requires Premium. Create a Spotify app with redirect `http://127.0.0.1:8888/callback`, then run `node scripts/spotify-auth.mjs <client-id>`.

## The protocol

All routes need `Authorization: Bearer <token>` except `/api/health`.

| Route | Purpose |
|---|---|
| `GET /api/status` | Dossier validity, brief-audio readiness, ring state |
| `GET /api/dossier` | The full dossier (headline, sections, evidence, brief script for captions) |
| `GET /api/brief.wav` | The pre-rendered brief; fetching it marks the call answered |
| `GET /api/brief-meta` | Per-paragraph timings for the read-along highlight and paragraph skip |
| `POST /api/feedback` | Reader comment on a paragraph, folded into the next dossier prompt |
| `POST /api/stt` | Raw audio in, transcript out |
| `POST /api/turn` | One voice turn: raw audio (or `{"text": ...}`) in, transcript + reply text + reply audio out |
| `POST /api/answered`, `/api/brief-ended`, `/api/hangup` | Call lifecycle |
| `POST /api/test-ring` | Ring now |

During the call the model has three tools: `capture_action` (appends a checkbox to `state/actions-<date>.md`; it never sends or executes anything), `read_evidence` (quotes a thread or email from the dossier word for word), and `send_link` (pushes a URL that appears in the dossier to you through the notify webhook). The system prompt refuses everything else: no invented numbers, no promises to "look into it."

## Reliability rules, learned the hard way

1. **No dossier, no ring.** `validateDossier` rejects wrong-date, thin, meta ("Got it — I'll prepare your briefing"), and promise-only briefs. A rejected dossier never overwrites a good one.
2. **Render before ringing.** The audio exists before the phone rings, so answering is instant.
3. **Runs before 15:00 brief today; later runs brief tomorrow.** A laptop opened at 12:30 still gets a same-day brief, written as a midday catch-up.
4. **Silence never reaches Whisper.** Whisper makes up text on silence (it produced Japanese from room noise). Defenses: the language is pinned, `sanitizeTranscript` drops artifacts and mostly non-Latin text, both handsets discard takes with no measured speech, and the system prompt treats sudden language switches as transcription noise.
5. **Freshness comes from file mtime, not the brain's word.** The brain makes up timestamps; the file system doesn't.
6. **The server is the scheduler of last resort.** launchd calendar fires go stale after a timezone change, missed fires collapse into one attempt, and a failed gather never retries. The server checks for timezone drift every 10 minutes (reloading the prefetch agent and restarting itself), and a watchdog re-runs the prefetch every 12+ minutes, up to 6 tries, until a valid dossier exists.
7. **Prefetch is single-flight.** `state/prefetch.lock` (PID-checked) makes overlapping launchd and watchdog runs no-ops.
8. **launchd defers respawns on battery.** A keep-alive respawn can sit at `pended nondemand spawn = inefficient` indefinitely, so both agents set `ProcessType Interactive`. When a job looks loaded but dead, read `launchctl print gui/$UID/<label>`.
9. **A closed lid on battery can't gather.** macOS force-sleeps regardless of `caffeinate`, and a gather that runs in dark-wake slivers produces a thin offline brief that blocks the real one. So the prefetch refuses to run on battery with the lid closed (exit 3), and the watchdog retries within about 2.5 minutes of opening the lid. Plugged in, `prefetch-awake.sh` keeps the Mac awake through the gather and the ring.

## The iOS handset

```bash
cd ios && xcodegen generate --spec project.yml
xcodebuild -project Daybreak.xcodeproj -scheme Daybreak -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' CODE_SIGNING_ALLOWED=NO build
```

To run on a device, open the generated project, pick your signing team, and change the `com.example` bundle prefix in `project.yml`. Pair with the server URL and `state/device-token`. Today the ring on iOS is a weekday 07:45 local notification. The app checks for a real dossier when opened.

## Layout

```
server/daybreak-server.mjs   the exchange (zero dependencies)
server/lib/                  dossier gate, call session + tools, AI client, ring scheduler, Slack + Spotify legs
server/mic-watch/            tiny Swift helper: is any app using the mic?
prefetch/dossier-prompt.md   the brain contract
prefetch/prefetch.mjs        runs the brain, validates, installs atomically
fixtures/                    demo dossier
web/call.html                browser handset
ios/                         native handset (SwiftUI, xcodegen)
scripts/daybreak.sh          install / status / ring / fixture / logs
state/                       dossier, audio, config, token, logs (gitignored)
```

## License

MIT
