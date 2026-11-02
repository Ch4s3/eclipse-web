// The JS half of Herald.Platform.Browser (browser.march): a <canvas id="herald">,
// keyboard and gamepad input with the SDL shim's button map, localStorage saves,
// and the frame scheduler Herald.run_frames uses. Also exports downloadSave and
// importSaveFile for a page's save links.
import { march_bytes_to_string, march_string_bytes } from "./march_runtime.mjs";

// The shim's button word (herald_sdl.c): game buttons in bits 0-12.
const A = 1, B = 2, SELECT = 4, START = 8, RIGHT = 16, LEFT = 32, UP = 64, DOWN = 128,
  R = 256, L = 512, ESCAPE = 1024, X = 2048, Y = 4096;
const UNFOCUSED = 2 ** 30;

// KeyboardEvent.code -> button, as the SDL shim maps scancodes. A game can
// replace it (hb_set_keys).
let KEYS = {
  ArrowRight: RIGHT, ArrowLeft: LEFT, ArrowUp: UP, ArrowDown: DOWN,
  KeyZ: A, KeyX: B, Enter: START, Backspace: SELECT, KeyA: L, KeyS: R,
  Escape: ESCAPE, KeyC: X, KeyV: Y,
};
// The standard gamepad mapping's buttons, as SDL's south/east/west/north etc.
const PAD = [[0, A], [1, B], [2, X], [3, Y], [8, SELECT], [9, START], [4, L], [5, R],
  [15, RIGHT], [14, LEFT], [12, UP], [13, DOWN]];

const st = {
  canvas: null, ctx: null, img: null, w: 0, h: 0,
  held: 0, focused: true, saveKey: "",
  pending: null,          // { id, k, p }: the scheduled frame
  lastNs: 0,              // the last time hb_now_ns reported
  offsetNs: 0,            // added to performance.now(): see runPendingNow
};

function storage() {
  try { return globalThis.localStorage || null; } catch (e) { return null; }
}

function fit() {
  if (!st.canvas) return;
  const vw = globalThis.innerWidth || st.w, vh = globalThis.innerHeight || st.h;
  const s = Math.max(1, Math.floor(Math.min(vw / st.w, vh / st.h)));
  st.canvas.style.width = st.w * s + "px";
  st.canvas.style.height = st.h * s + "px";
}

function toggleFullscreen() {
  const d = globalThis.document;
  if (!d) return;
  if (d.fullscreenElement) d.exitFullscreen?.();
  else st.canvas?.requestFullscreen?.();
}

function setFocused(on) {
  st.focused = on;
  if (!on) st.held = 0;
}

// The page is being hidden: run the scheduled frame now (the browser stops
// animation frames for hidden pages), with the clock moved on a frame's worth
// so Herald has a frame due and the game sees focus lost (and can save). The
// offset stays, so the clock never runs backwards.
// Run one scheduled frame. A panic in the game (frame, tick, draw, present)
// stops the loop and says so on the page, rather than leaving a frozen canvas.
function runFrame(k, p) {
  try { k._0(k, p); }
  catch (e) {
    st.pending = null;
    console.error(e);
    hb_status("The game stopped: " + (e && e.message ? e.message : String(e)) + ". Reload to start again.", true);
  }
}

function runPendingNow() {
  const p = st.pending;
  if (!p) return;
  st.pending = null;
  const want = st.lastNs + 17000000;
  const real = Math.round(performance.now() * 1e6) + st.offsetNs;
  if (real < want) st.offsetNs += want - real;
  globalThis.cancelAnimationFrame?.(p.id);
  runFrame(p.k, p.p);
}

// "Code=bits,Code=bits": the whole key map, replacing the default.
export function hb_set_keys(spec) {
  const map = {};
  for (const part of spec.split(",")) {
    const [code, bits] = part.split("=");
    if (code && bits !== undefined) map[code.trim()] = Number(bits);
  }
  KEYS = map;
  st.held = 0;
  return 0;
}

export function hb_open(w, h) {
  const d = globalThis.document;
  if (!d) return "no document to draw in";
  let c = d.getElementById("herald");
  if (!c) {
    c = d.createElement("canvas");
    c.id = "herald";
    d.body?.appendChild(c);
  }
  const ctx = c.getContext ? c.getContext("2d") : null;
  if (!ctx) return "this browser has no 2D canvas";
  c.width = w; c.height = h;
  c.style.imageRendering = "pixelated";
  ctx.imageSmoothingEnabled = false;
  Object.assign(st, { canvas: c, ctx, w, h, img: new ImageData(w, h), held: 0, focused: !d.hidden });
  globalThis.addEventListener("keydown", (e) => {
    if (e.code === "Enter" && e.altKey) { toggleFullscreen(); e.preventDefault(); return; }
    if (e.code === "KeyF" && e.ctrlKey && e.metaKey) { toggleFullscreen(); e.preventDefault(); return; }
    if (e.metaKey || e.ctrlKey) return;    // browser and OS shortcuts (Cmd+Q, Ctrl+F) aren't game keys
    const b = KEYS[e.code];
    if (b !== undefined) { st.held |= b; e.preventDefault(); }
  });
  globalThis.addEventListener("keyup", (e) => {
    const b = KEYS[e.code];
    if (b !== undefined) { st.held &= ~b; e.preventDefault(); }
  });
  globalThis.addEventListener("blur", () => setFocused(false));
  globalThis.addEventListener("focus", () => setFocused(true));
  globalThis.addEventListener("resize", fit);
  d.addEventListener("visibilitychange", () => {
    if (d.hidden) { setFocused(false); runPendingNow(); }
    else setFocused(true);
  });
  fit();
  try { globalThis.navigator?.storage?.persist?.().catch(() => {}); } catch (e) {}
  return "";
}

export function hb_poll() {
  let bits = st.held;
  const pads = globalThis.navigator?.getGamepads?.() || [];
  const pad = Array.from(pads).find((p) => p && p.connected !== false);
  if (pad && pad.buttons) for (const [i, b] of PAD) if (pad.buttons[i]?.pressed) bits |= b;
  if (!st.focused) bits = UNFOCUSED;
  return bits;
}

export function hb_present(rgba) {
  const n = st.w * st.h;
  if (rgba.length < n) return -1;
  // The framebuffer's words are R, G, B, A bytes (little-endian), as SDL
  // uploads them; force alpha opaque, as the SDL texture does.
  const dst = new Uint32Array(st.img.data.buffer, st.img.data.byteOffset, n);
  for (let i = 0; i < n; i++) dst[i] = rgba[i] | 0xFF000000;
  st.ctx.putImageData(st.img, 0, 0);
  return 1;
}

export function hb_now_ns() {
  st.lastNs = Math.round(performance.now() * 1e6) + st.offsetNs;
  return st.lastNs;
}

export function hb_save(key, data) {
  const s = storage();
  if (!s) return false;
  try { s.setItem(key, data); return true; } catch (e) { return false; }
}

const none = { $: "None" };
export function hb_read_save(key) {
  const s = storage();
  if (!s) return none;
  try { const v = s.getItem(key); return v === null ? none : { $: "Some", _0: v }; } catch (e) { return none; }
}

export function hb_take_import(key) {
  const s = storage();
  if (!s) return none;
  try {
    const v = s.getItem(key + ".import");
    if (v === null) return none;
    s.removeItem(key + ".import");
    return { $: "Some", _0: v };
  } catch (e) { return none; }
}

export function hb_set_save_key(key) { st.saveKey = key; return 0; }
export function hb_save_key() { return st.saveKey; }

export function hb_status(msg, isError) {
  const el = globalThis.document?.getElementById("herald-status");
  if (!el) return 0;
  el.textContent = msg;
  el.hidden = msg === "";
  el.className = isError ? "error" : "";
  return 0;
}

export function hb_schedule(k, p) {
  const id = globalThis.requestAnimationFrame(() => {
    if (st.pending && st.pending.id === id) { st.pending = null; runFrame(k, p); }
  });
  st.pending = { id, k, p };
}

// Raw bytes as a March byte string (see "Byte strings" in March's JS backend docs).
export async function hb_fetch_asset(name) {
  if (typeof process !== "undefined" && process.versions?.node && typeof window === "undefined") {
    const fs = await import("node:fs/promises");
    return march_bytes_to_string(new Uint8Array(await fs.readFile(name)));
  }
  const r = await fetch(name);
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return march_bytes_to_string(new Uint8Array(await r.arrayBuffer()));
}

// ── For the page ──────────────────────────────────────────────────────────

// Download the save stored under `key` as `filename`: the save's bytes, the
// same file a desktop build writes. False when there is none.
export function downloadSave(key, filename) {
  const s = storage();
  const data = s ? s.getItem(key) : null;
  if (data === null) return false;
  const url = URL.createObjectURL(new Blob([march_string_bytes(data)], { type: "application/octet-stream" }));
  const a = globalThis.document.createElement("a");
  a.href = url; a.download = filename;
  globalThis.document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

// Store a chosen save file under `key + ".import"` and reload; the game checks
// it at startup (Herald.Platform.Browser.take_import) and keeps its own save
// if the file doesn't restore.
export async function importSaveFile(key, file) {
  const s = storage();
  if (!s) return false;
  s.setItem(key + ".import", march_bytes_to_string(new Uint8Array(await file.arrayBuffer())));
  globalThis.location.reload();
  return true;
}
