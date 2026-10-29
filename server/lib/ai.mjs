// AI client: chat (Anthropic Messages API), TTS + STT (OpenAI audio API).
// Zero dependencies; Node 24 fetch/FormData/Blob.
//
// Keys: ANTHROPIC_API_KEY and OPENAI_API_KEY, from the environment or
// daybreak/.env. ANTHROPIC_BASE_URL / OPENAI_BASE_URL point either side at a
// compatible gateway instead.

import "./env.mjs";

const ANTHROPIC_BASE = () => (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
const OPENAI_BASE = () => (process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/$/, "");

async function timedFetch(url, init, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function requireKey(name) {
  const key = process.env[name];
  if (!key) throw new Error(`No ${name} (set it in the environment or daybreak/.env)`);
  return key;
}

function anthropicFetch(path, init, timeoutMs) {
  const headers = {
    "x-api-key": requireKey("ANTHROPIC_API_KEY"),
    "anthropic-version": "2023-06-01",
    ...(init.headers || {}),
  };
  return timedFetch(`${ANTHROPIC_BASE()}${path}`, { ...init, headers }, timeoutMs);
}

function openaiFetch(path, init, timeoutMs) {
  const headers = { Authorization: `Bearer ${requireKey("OPENAI_API_KEY")}`, ...(init.headers || {}) };
  return timedFetch(`${OPENAI_BASE()}${path}`, { ...init, headers }, timeoutMs);
}

export const DEFAULT_CHAT_MODEL = "claude-sonnet-5-5";

// Some models emit thinking blocks by default; we ask for it off (latency),
// and fall back if the param is rejected. Response text extraction filters to
// text blocks either way.
let thinkingParamRejected = false;

export async function chat({ system, messages, tools, model = DEFAULT_CHAT_MODEL, maxTokens = 700 }) {
  const body = { model, max_tokens: maxTokens, system, messages };
  if (tools?.length) body.tools = tools;
  if (!thinkingParamRejected) body.thinking = { type: "disabled" };

  const send = () =>
    anthropicFetch("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  let res = await send();
  if (res.status === 400 && !thinkingParamRejected) {
    const errText = await res.text();
    if (/thinking/i.test(errText)) {
      thinkingParamRejected = true;
      delete body.thinking;
      res = await send();
    } else {
      throw new Error(`chat 400: ${errText.slice(0, 400)}`);
    }
  }
  if (!res.ok) throw new Error(`chat ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return res.json();
}

export function textOf(message) {
  return (message.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
}

export function toolUsesOf(message) {
  return (message.content || []).filter((b) => b.type === "tool_use");
}

const TTS_STYLE =
  "Warm, calm, confident chief-of-staff voice delivering a morning briefing. " +
  "Natural pacing, not rushed. Read numbers as words: say 'twenty-one point four percent' " +
  "not 'two-one-point-four'. Short pauses between topics.";

export async function tts(text, { voice = "nova", instructions = TTS_STYLE } = {}) {
  const res = await openaiFetch("/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice,
      input: text,
      response_format: "wav",
      instructions,
    }),
  }, 90_000);
  if (!res.ok) throw new Error(`tts ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return Buffer.from(await res.arrayBuffer());
}

// gpt-4o-mini-tts input cap is ~4k chars; long briefs render in sentence
// chunks and concatenate. All chunks share one format (24kHz mono pcm16).
export async function ttsLong(text, opts = {}) {
  const LIMIT = 3500;
  if (text.length <= LIMIT) return tts(text, opts);
  const chunks = [];
  let current = "";
  for (const sentence of text.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) || [text]) {
    if (current.length + sentence.length > LIMIT && current) {
      chunks.push(current);
      current = "";
    }
    current += sentence;
  }
  if (current.trim()) chunks.push(current);
  const wavs = [];
  for (const c of chunks) wavs.push(await tts(c, opts));
  return wavConcat(wavs);
}

// Concatenate standard PCM WAVs by locating each 'data' chunk (headers can
// carry extra LIST/fact chunks, so never assume byte 44).
export function wavConcat(buffers) {
  if (buffers.length === 1) return buffers[0];
  const parts = buffers.map(findDataChunk);
  const dataLen = parts.reduce((n, p) => n + p.data.length, 0);
  const first = buffers[0];
  const head = Buffer.from(first.subarray(0, parts[0].offset));
  const out = Buffer.concat([head, ...parts.map((p) => p.data)]);
  out.writeUInt32LE(out.length - 8, 4); // RIFF size
  out.writeUInt32LE(dataLen, parts[0].offset - 4); // data chunk size
  return out;
}

// Duration in seconds of a standard PCM WAV: data-chunk bytes over the fmt
// chunk's byte rate. Lets the brief render record exact per-paragraph offsets.
export function wavDuration(buf) {
  let pos = 12, byteRate = 0, dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") byteRate = buf.readUInt32LE(pos + 16);
    if (id === "data") dataLen = Math.min(size, buf.length - pos - 8);
    pos += 8 + size + (size % 2);
  }
  if (!byteRate || !dataLen) throw new Error("wavDuration: missing fmt/data chunk");
  return dataLen / byteRate;
}

function findDataChunk(buf) {
  let pos = 12; // past RIFF....WAVE
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "data") return { offset: pos + 8, data: buf.subarray(pos + 8, pos + 8 + size) };
    pos += 8 + size + (size % 2);
  }
  throw new Error("No data chunk in WAV");
}

export async function stt(audioBuffer, { mime = "audio/wav", filename = "turn.wav", language = "en" } = {}) {
  const fd = new FormData();
  fd.append("model", "whisper-1");
  fd.append("file", new Blob([audioBuffer], { type: mime }), filename);
  // Pin the language: on silence/ambient noise whisper hallucinates text in
  // other scripts (famously Japanese). Field-verified on Daybreak's first call.
  if (language) fd.append("language", language);
  const res = await openaiFetch("/v1/audio/transcriptions", { method: "POST", body: fd }, 45_000);
  if (!res.ok) throw new Error(`stt ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return sanitizeTranscript((json.text || "").trim(), language);
}

// Whisper silence-hallucination filter: for a Latin-script language, a
// transcript that is mostly non-Latin letters is noise, not speech. Also drop
// whisper's canonical silence artifacts.
const SILENCE_ARTIFACTS = /^(thank(s| you)[.!]?|you[.!]?|bye[.!]?|\.+)$/i;
export function sanitizeTranscript(text, language = "en") {
  if (!text) return "";
  if (SILENCE_ARTIFACTS.test(text.trim())) return "";
  if (!["en", "es", "fr", "de", "it", "pt", "nb", "no", "sv", "da", "nl"].includes(language)) return text;
  const letters = [...text].filter((ch) => /\p{L}/u.test(ch));
  if (!letters.length) return "";
  const latin = letters.filter((ch) => /\p{Script=Latin}/u.test(ch));
  return latin.length / letters.length < 0.5 ? "" : text;
}
