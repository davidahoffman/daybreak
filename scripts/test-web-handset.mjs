#!/usr/bin/env node
// Regression check for the web handset's invisible paragraph skip (→ key / tap an
// unread paragraph / skip past the last one ends the brief). Drives the real
// page in headless Chrome over the DevTools protocol against the live server.
//
//   node scripts/test-web-handset.mjs
//
// Needs: the server up on :7745 with a valid dossier and brief.wav, and Google
// Chrome installed. Side effect: answering fetches /api/brief.wav, which marks
// today's call answered — run it after the morning call, not before the ring.
import { spawn } from "node:child_process";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/daybreak-cdp-profile",
  "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required",
  "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--window-size=430,900", "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(200); } }
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const logs = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else if (d.method === "Runtime.consoleAPICalled") logs.push(d.params.args.map((a) => a.value ?? a.description).join(" ")); else if (d.method === "Runtime.exceptionThrown") logs.push("EXC " + d.params.exceptionDetails.text + " " + (d.params.exceptionDetails.exception?.description || "")); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error("page threw: " + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result.result.value; };
const key = async (code, vk) => { for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, code, key: code, windowsVirtualKeyCode: vk }); };
const results = []; const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  [" + detail + "]" : "")); };
const snap = () => ev(`JSON.stringify({ t: +briefAudio.currentTime.toFixed(2), paused: briefAudio.paused, active: lastActivePara, now: briefParas.map(p => p.el.classList.contains("now")), done: briefParas.map(p => p.el.classList.contains("done")), starts: briefParas.map(p => p.startSec), hint: document.getElementById("callHint").textContent, combox: !!openCombox, orbListening: document.getElementById("call").classList.contains("listening"), state })`).then(JSON.parse);
const near = (a, b) => Math.abs(a - b) < 0.6;

try {
  await send("Runtime.enable"); await send("Page.enable");
  await send("Page.navigate", { url: "http://localhost:7745/" });
  for (let i = 0; i < 50 && await ev(`document.getElementById("answerBtn").style.display`) === "none"; i++) await sleep(200);
  check("home shows the answer button (dossier valid + brief.wav ready)", await ev(`document.getElementById("answerBtn").style.display`) !== "none");
  await ev(`answer()`);
  for (let i = 0; i < 50 && !(await ev(`!!briefAudio && !briefAudio.paused && briefParas.length > 1`)); i++) await sleep(200);
  let s = await snap();
  check("brief is playing with per-paragraph timings", !s.paused && s.starts.length > 1, `paras=${s.starts.length} starts=${JSON.stringify(s.starts)}`);
  check("first paragraph inked immediately after play()", s.active === 0 && s.now[0], `active=${s.active}`);
  await sleep(1200); s = await snap();
  check("audio actually advances in headless (timeupdate alive)", s.t > 0.5, `t=${s.t}`);

  // → advances to the next paragraph
  await key("ArrowRight", 39); await sleep(150); s = await snap();
  check("ArrowRight seeks to paragraph 2 start", near(s.t, s.starts[1]) && s.active === 1 && s.now[1] && s.done[0] && !s.now[0], `t=${s.t} start=${s.starts[1]} active=${s.active}`);

  // tapping an unread paragraph jumps there
  await ev(`briefParas[3].el.click()`); await sleep(150); s = await snap();
  check("tapping unread paragraph 4 seeks there", near(s.t, s.starts[3]) && s.active === 3 && s.now[3] && s.done[2] && !s.combox, `t=${s.t} start=${s.starts[3]} combox=${s.combox}`);

  // tapping an already-read paragraph still opens the comment box (no seek)
  const before = s.t;
  await ev(`briefParas[1].el.click()`); await sleep(150); s = await snap();
  check("tapping a read paragraph opens comment box, does not seek back", s.combox && s.active === 3 && s.t >= before, `combox=${s.combox} t=${s.t}`);
  // ArrowRight while typing in the comment box must not skip
  await ev(`openCombox.querySelector("input").focus()`);
  await key("ArrowRight", 39); await sleep(150); const s2 = await snap();
  check("ArrowRight inside the comment input is ignored", s2.active === 3 && !s2.paused, `active=${s2.active}`);
  await key("Escape", 27); await sleep(150); s = await snap();
  check("Escape closes the comment box", !s.combox);

  // barge-in pause disables skipping; resume re-enables
  await ev(`briefAudio.pause()`); const tp = (await snap()).t;
  await key("ArrowRight", 39); await sleep(150); s = await snap();
  check("ArrowRight while paused is a no-op", s.paused && near(s.t, tp) && s.active === 3, `t=${s.t}`);
  await ev(`briefAudio.play()`); await sleep(200);

  // skip to the last paragraph, then past it → brief ends the normal way
  await key("ArrowRight", 39); await sleep(150); s = await snap();
  check("ArrowRight reaches the last paragraph", s.active === s.starts.length - 1 && s.now[s.starts.length - 1], `active=${s.active}`);
  await key("ArrowRight", 39); await sleep(200); s = await snap();
  check("ArrowRight past the last paragraph ends the brief", s.paused && s.now.every((x) => !x) && s.done.every(Boolean) && s.orbListening && s.hint.startsWith("your line"), `paused=${s.paused} hint="${s.hint}" listening=${s.orbListening}`);
  await ev(`briefParas[2].el.click()`); await sleep(150); s = await snap();
  check("after the brief, tapping any paragraph opens the comment box", s.combox);
  await key("Escape", 27); await sleep(100);
  await key("ArrowRight", 39); await sleep(150); s = await snap();
  check("ArrowRight after the brief is a no-op (still paused, still call state)", s.paused && s.state === "call");
  await ev(`briefAudio.currentTime = briefAudio.duration - 0.05; briefAudio.play()`); await sleep(900); s = await snap();
  check("natural onended path was detached by the manual end (no double endBrief crash)", s.paused && s.hint.startsWith("your line"));
} catch (e) { console.log("HARNESS ERROR", e.message); results.push({ ok: false }); }
finally {
  if (logs.length) console.log("page console:\n  " + logs.join("\n  "));
  ws.close(); chrome.kill();
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
