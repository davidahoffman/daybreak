// In-call brain: a Claude model with a small tool belt, grounded in the
// dossier. One session per morning; hangup or a new dossier day resets it.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chat, textOf, toolUsesOf, DEFAULT_CHAT_MODEL } from "./ai.mjs";
import { dossierForPrompt, localDateString } from "./dossier.mjs";
import { notify } from "./notify.mjs";

const TOOLS = [
  {
    name: "capture_action",
    description:
      "Queue a follow-up action for the user to review after the call (a reminder, a draft to write, " +
      "a thread to answer, a task). Daybreak never sends or executes anything itself — this only " +
      "writes to the user's local morning-actions file.",
    input_schema: {
      type: "object",
      properties: {
        note: { type: "string", description: "One clear line describing the action, written for the user's own to-do list" },
      },
      required: ["note"],
    },
  },
  {
    name: "read_evidence",
    description:
      "Read the full raw text of an evidence item from this morning's dossier (a Slack thread, an email). " +
      "Use when the user asks what someone actually said, or for details beyond the section summaries.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Evidence id from the dossier's evidence list" },
      },
      required: ["id"],
    },
  },
  {
    name: "send_link",
    description:
      "Send a URL to the user's own Slack as a push notification — the only way to hand them something " +
      "clickable, since a URL can't be spoken. Goes only to the user themself, never to anyone else. " +
      "Use when they ask for a link, a PR, a doc, a thread, or say 'send me that'. The URL must appear " +
      "verbatim in the dossier (an evidence item's url field or inside its text) — never invent or " +
      "reconstruct one.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL exactly as it appears in the dossier" },
        label: {
          type: "string",
          description: "One short line saying what this is, e.g. 'PR #123 — onboarding copy fix'",
        },
      },
      required: ["url", "label"],
    },
  },
];

function systemPrompt(dossier, userName) {
  return `You are Daybreak, ${userName ? `${userName}'s` : "the user's"} morning call — the voice on the line when their phone rings at 07:45.

Personality: a world-class chief of staff. Calm, warm, direct, zero filler. You already delivered the spoken brief; now you answer follow-up questions about it.

Hard rules:
- Everything you say is SPOKEN aloud. 1-3 short sentences unless asked to go deeper. Read numbers as words. Never use markdown, bullets, or headings.
- Ground every claim in the dossier below. When asked what someone actually said, use read_evidence and quote their exact words.
- If the answer is not in the dossier, say so plainly ("that's not in this morning's dossier") and offer to queue it as a follow-up with capture_action. Never guess, never fabricate.
- Links: a URL can never be spoken. When the user asks for a link, a PR, a doc, or says "send me that" — find the exact URL in the dossier (an evidence item's url field, or a URL inside its text) and use send_link, then confirm aloud in a few words ("sent it to your Slack"). If the dossier has no URL for it, say so and offer capture_action so it gets tracked down after the call. Never invent, guess, or reconstruct a URL — send only what appears verbatim in the dossier.
- You cannot message other people, reply to threads, run commands, or change anything — send_link to the user's own Slack is the single exception. When the user says "queue that", "remind me", "draft that later" — use capture_action, then confirm in five words or fewer what you captured.
- Never promise work you cannot do on this call.
- The user may interrupt or speak tersely. "what did sam say" means find Sam in the dossier and quote them.
- Always reply in English. The transcript comes from speech-to-text; if a turn arrives in another language or reads like noise, it is a transcription artifact — say you didn't catch that and ask them to say it again. Never switch languages.

Today's dossier (${dossier.date}):
${dossierForPrompt(dossier)}`;
}

export class CallSession {
  constructor({ statePath, userName = null, model = DEFAULT_CHAT_MODEL, log = () => {} }) {
    this.statePath = statePath;
    this.userName = userName;
    this.model = model;
    this.log = log;
    this.reset(null);
  }

  reset(dossier) {
    this.dossier = dossier;
    this.history = [];
    this.capturedActions = [];
  }

  ensureDossier(dossier) {
    // New morning (or first call) → fresh session grounded in today's dossier.
    if (!this.dossier || this.dossier.date !== dossier.date || this.dossier.generatedAt !== dossier.generatedAt) {
      this.reset(dossier);
    }
  }

  actionsFile() {
    const dir = join(this.statePath);
    mkdirSync(dir, { recursive: true });
    return join(dir, `actions-${localDateString()}.md`);
  }

  async executeTool(name, input) {
    if (name === "capture_action") {
      const note = String(input.note || "").trim();
      if (!note) return "No note provided.";
      const stamp = new Date().toTimeString().slice(0, 5);
      appendFileSync(this.actionsFile(), `- [ ] ${stamp} — ${note}\n`);
      this.capturedActions.push(note);
      this.log("action_captured", { note });
      return `Captured: ${note}`;
    }
    if (name === "read_evidence") {
      const id = String(input.id || "");
      const item = (this.dossier?.evidence || []).find((e) => e.id === id);
      if (!item) {
        const ids = (this.dossier?.evidence || []).map((e) => e.id).join(", ") || "none";
        return `No evidence with id "${id}". Available ids: ${ids}`;
      }
      return item.text || JSON.stringify(item);
    }
    if (name === "send_link") {
      const url = String(input.url || "").trim();
      const label = String(input.label || "").trim() || "Link from this morning's call";
      if (!/^https?:\/\/\S+$/.test(url)) {
        return `"${url}" is not a full URL. Only send URLs that appear verbatim in the dossier.`;
      }
      // The prompt says "verbatim from the dossier"; this makes it a guarantee
      // instead of a hope — a reconstructed or misheard URL never reaches Slack.
      if (!JSON.stringify(this.dossier || {}).includes(url)) {
        this.log("link_rejected", { url });
        return `"${url}" is not in this morning's dossier. Say so and offer capture_action instead.`;
      }
      const ok = await notify({ headline: `🔗 ${label}`, permalink: url, log: this.log });
      if (!ok) {
        return "Sending to Slack failed. Tell the user plainly and offer capture_action so it isn't lost.";
      }
      this.log("link_sent", { url, label });
      return `Sent to the user's Slack: ${label} — ${url}`;
    }
    return `Unknown tool ${name}`;
  }

  // One user turn → assistant reply text. Runs the tool loop (max 4 rounds).
  // Never returns empty — Shelly's SHELLY-14 stranding lesson.
  async turn(userText) {
    if (!this.dossier) {
      return {
        replyText: "I don't have a dossier yet this morning. Give me a few minutes and call back.",
        capturedActions: [],
        degraded: true,
      };
    }
    this.history.push({ role: "user", content: userText });
    const newActions = [];
    const actionsBefore = this.capturedActions.length;

    try {
      let messages = [...this.history];
      let reply = "";
      for (let round = 0; round < 4; round++) {
        const response = await chat({
          system: systemPrompt(this.dossier, this.userName),
          messages,
          tools: TOOLS,
          model: this.model,
          maxTokens: 700,
        });
        const toolUses = toolUsesOf(response);
        reply = textOf(response) || reply;
        if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

        // Anthropic tool protocol: echo the assistant content, then results.
        const toolResults = [];
        for (const tu of toolUses) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: await this.executeTool(tu.name, tu.input || {}),
          });
        }
        messages = [
          ...messages,
          { role: "assistant", content: response.content },
          { role: "user", content: toolResults },
        ];
      }

      if (!reply.trim()) reply = "I lost my train of thought there. Ask me that once more?";
      this.history.push({ role: "assistant", content: reply });
      if (this.history.length > 24) this.history = this.history.slice(-24);
      newActions.push(...this.capturedActions.slice(actionsBefore));
      return { replyText: reply, capturedActions: newActions };
    } catch (err) {
      this.log("turn_error", { error: String(err) });
      // Keep history consistent: drop the failed user turn so a retry re-adds it.
      this.history.pop();
      return {
        replyText: "I'm having trouble reaching my brain right now. The dossier is still on your screen, and I'll be fine in a moment.",
        capturedActions: [],
        degraded: true,
      };
    }
  }
}
