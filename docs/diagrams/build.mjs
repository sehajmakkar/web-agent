// Generates the architecture diagrams from ONE spec, so every phase uses the same layout and only what changed moves.
//   node docs/diagrams/build.mjs [--view <file>]
// Writes docs/diagrams/phase-{1..4}-*.excalidraw (green = new in that phase, amber = changed) and
// architecture-evolution.excalidraw (all four side by side). --view also writes the animated "evolution" element list
// used with the Excalidraw connector (each element tagged with the phase that introduced it).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.dirname(fileURLToPath(import.meta.url));
const FS = 18; // body font size
const LINE = 23;

// ---- layout grid ----
// 90px gutters so arrow labels sit between boxes, not on them; everything fits a 1600px-wide frame.
const COL = { A: [40, 230], B: [360, 280], C: [730, 330], D: [1150, 320] };
const ROW = { r1: 130, r2: 310, r3: 480, r4: 700, r5: 860 };
const FILL = {
  ui: ["#a5d8ff", "#1971c2"], server: ["#d0bfff", "#6741d9"], agent: ["#d0bfff", "#6741d9"], memory: ["#c3fae8", "#0c8599"],
  model: ["#fff3bf", "#e67700"], tool: ["#ffd8a8", "#e8590c"], web: ["#e9ecef", "#495057"], note: ["#fff9db", "#e67700"],
};
const box = (id, col, row, kind, text, extra = {}) => ({ id, x: COL[col][0], y: ROW[row], kind, text, ...extra, w: extra.w ?? COL[col][1] });
const arrow = (id, from, to, fp, tp, label, extra = {}) => ({ id, from, to, fp, tp, label, ...extra });

// ---- the four phases ----
// `since` = phase that introduced the element. A later phase may override an element's text (= "changed").
const PHASES = [
  {
    n: 1, slug: "phase-1-skeleton",
    title: "Phase 0-1 · Walking skeleton: streaming chat + ONE tool",
    subtitle: "Measured: no-search turn 1.4s · cited answer 4.9s · all prompt input assembled in one file",
    boxes: [
      box("ui", "A", "r1", "ui", "Browser UI\nVite + React\nstreams text + status\n[n] citations"),
      box("server", "B", "r1", "server", "Hono server\nPOST /api/chat\n-> SSE event stream\ntransport only"),
      box("loop", "C", "r1", "agent", "Agent loop · runTurn()\nstream -> parallel tool calls\n-> results -> stream again\n<= 4 steps · 45s budget\ncitations validated"),
      box("context", "C", "r2", "agent", "context.ts: all prompt input\nstatic system prompt (cached)\n+ <turn_context>: now, tz"),
      box("model", "D", "r1", "model", "ModelClient (provider-neutral)\nGemini 3.5 Flash-Lite\n503 / timeout -> fallback\n429 -> clear quota error"),
      box("tool", "D", "r2", "tool", "web_search: the ONE tool\nqueries[] run in parallel\nurls[] = re-read live pages\nsources numbered [n]\nwrapped as untrusted"),
      box("providers", "D", "r3", "tool", "SearchProvider\nExa fast (0.7s p50)\n-> Tavily fallback\n10-min cache"),
      box("web", "D", "r4", "web", "The web", { shape: "ellipse", h: 90, w: 200, x: 1210 }),
      box("p0", "A", "r2", "note", "Phase 0 · measure before building\n- 3.8 Flash: 20 req/day + 503s -> 3.5 Flash-Lite\n- Exa: primary source 13/14 vs Tavily 10/14\n- the model never fills `since` -> code will\n- 'on Monday' read as NEXT Monday\n- Gemini quirks: CRLF SSE, thoughtSignature", { w: 600, only: [1] }),
    ],
    arrows: [
      arrow("a_ui_srv", "ui", "server", [1, 0.5], [0, 0.5], "chat · SSE"),
      arrow("a_srv_loop", "server", "loop", [1, 0.5], [0, 0.5], "runTurn()"),
      arrow("a_loop_model", "loop", "model", [1, 0.3], [0, 0.5], "stream()"),
      arrow("a_loop_tool", "loop", "tool", [1, 0.8], [0, 0.25], "tool calls"),
      arrow("a_ctx_loop", "context", "loop", [0.5, 0], [0.5, 1], ""),
      arrow("a_tool_prov", "tool", "providers", [0.5, 1], [0.5, 0], ""),
      arrow("a_prov_web", "providers", "web", [0.5, 1], [0.5, 0], ""),
    ],
  },
  {
    n: 2, slug: "phase-2-persistence",
    title: "Phase 2 · Persistence + time",
    subtitle: "History lives in SQLite, owned by the server · AGENT_NOW makes '3 November' testable",
    changes: {
      ui: "Browser UI\n+ sidebar by day\n+ deep links #c=<id>\nstreams text + [n]",
      server: "Hono server · SSE\nowns history (client: id)\nsaves the question first",
    },
    boxes: [
      box("clock", "A", "r2", "memory", "clock.ts\nonly source of 'now'\nAGENT_NOW: time travel"),
      box("demo", "A", "r3", "memory", "npm run demo\nbackdated fixtures\nown DB + own ports"),
      box("store", "B", "r2", "memory", "store.ts: all SQL\nlocal_date in user's tz\nsource snapshot / answer"),
      box("sqlite", "B", "r3", "memory", "SQLite (better-sqlite3)\nconversations\nmessages + FTS5 index\nsource snapshots"),
    ],
    arrows: [
      arrow("a_srv_store", "server", "store", [0.5, 1], [0.5, 0], "history · save"),
      arrow("a_store_db", "store", "sqlite", [0.5, 1], [0.5, 0], ""),
      arrow("a_clock_srv", "clock", "server", [1, 0.25], [0, 0.85], "now()"),
      arrow("a_demo_db", "demo", "sqlite", [1, 0.5], [0, 0.5], "seed"),
    ],
  },
  {
    n: 3, slug: "phase-3-temporal-memory",
    title: "Phase 3 · Temporal memory: code decides, the model writes",
    subtitle: "Each flow failed live once; every fix moved a decision from the model into code",
    changes: {
      loop: "Agent loop · runTurn()\nparallel tool calls\ntext before a tool call\n= draft -> discarded (reset)\nonly the final step answers",
      context: "context.ts\nstatic system prompt (cached)\n+ <turn_context>: dates, window\n+ <memory> block",
      tool: "web_search: the ONE tool\nsince: forced by code\ndual retrieval: window +\ncurrent (undated) pages\nolder items = background",
    },
    boxes: [
      box("planner", "C", "r3", "memory", "planMemory(): code, no LLM, ~ms\n1. resolve dates\n2. recall by date, then topic\n3. coverage + 30-day index\n4. since -> every search\n5. checklist / no-record policy"),
      box("temporal", "C", "r4", "memory", "temporal.ts (25 tests)\n'last Tuesday' = 10 or 3 Nov\nbare weekday = past"),
    ],
    arrows: [
      arrow("a_db_plan", "sqlite", "planner", [1, 0.5], [0, 0.4], "recall"),
      arrow("a_temp_plan", "temporal", "planner", [0.5, 0], [0.5, 1], ""),
      arrow("a_plan_ctx", "planner", "context", [0.5, 0], [0.5, 1], "<memory>"),
      arrow("a_plan_tool", "planner", "tool", [1, 0.25], [0, 0.85], "since", { dashed: true }),
    ],
  },
  {
    n: 4, slug: "phase-4-evidence-ledger",
    title: "Phase 4 · Evidence ledger",
    subtitle: "Real exchanges become memory (claims + sources + user decisions) · re-check 6.0s -> 4.5s",
    changes: {
      sqlite: "SQLite\nconversations, messages\n+ FTS5 · source snapshots\nclaims (supersede history)\nnotes: user decisions",
      planner: "planMemory(): code, no LLM, ~ms\n1. resolve dates\n2. recall by date, then topic\n3. coverage + 30-day index\n4. since -> every search\n5. checklist / no-record policy\n6. verifyUrls -> re-read first",
    },
    arrowLabels: { a_plan_tool: "since + prefetch" },
    boxes: [
      box("extract", "B", "r5", "memory", "ExtractionQueue\nafter each saved answer\nclaims -> cited source only\nnext turn waits <= 1.5s"),
      box("xmodel", "C", "r5", "model", "Extract model\nFlash-Lite · JSON schema\n+ zod validation"),
    ],
    arrows: [
      arrow("a_x_db", "extract", "sqlite", [0.5, 0], [0.5, 1], "claims · notes · topics"),
      arrow("a_x_model", "extract", "xmodel", [1, 0.5], [0, 0.5], ""),
    ],
  },
];

// ---- resolve the state of each phase (cumulative) ----
function stateAt(n) {
  const boxes = new Map();
  const arrows = new Map();
  const status = new Map(); // id -> "new" | "changed"
  for (const p of PHASES.filter((p) => p.n <= n)) {
    for (const b of p.boxes) {
      if (b.only && !b.only.includes(n)) continue;
      boxes.set(b.id, { ...b, phase: p.n });
      if (p.n === n && n > 1) status.set(b.id, "new"); // Phase 1 is the baseline: nothing to highlight
    }
    for (const [id, text] of Object.entries(p.changes ?? {})) {
      boxes.set(id, { ...boxes.get(id), text, changedIn: p.n });
      if (p.n === n) status.set(id, "changed");
    }
    for (const a of p.arrows) arrows.set(a.id, { ...a, phase: p.n });
    for (const [id, label] of Object.entries(p.arrowLabels ?? {})) arrows.set(id, { ...arrows.get(id), label });
  }
  for (const b of boxes.values()) b.h = b.h ?? b.text.split("\n").length * LINE + 30;
  return { phase: PHASES.find((p) => p.n === n), boxes, arrows, status };
}

// ---- native .excalidraw elements ----
let seed = 1000;
const base = (o) => ({
  angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid",
  roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: ++seed, version: 1, versionNonce: seed * 7919,
  isDeleted: false, boundElements: [], updated: 1762800000000, link: null, locked: false, ...o,
});
const textEl = (o) => {
  const lines = o.text.split("\n");
  const fs = o.fontSize ?? FS;
  const width = Math.max(...lines.map((l) => l.length)) * fs * 0.55;
  const height = lines.length * fs * 1.25;
  return base({
    type: "text", fontSize: fs, fontFamily: 1, textAlign: o.textAlign ?? "left", verticalAlign: o.verticalAlign ?? "top",
    containerId: null, originalText: o.text, lineHeight: 1.25, autoResize: true, width, height, ...o,
  });
};

function nativeElements(n, dx = 0) {
  const { phase, boxes, arrows, status } = stateAt(n);
  const els = [];
  const byId = new Map();
  const pid = (id) => `${id}-p${n}`;

  els.push(textEl({ id: pid("title"), x: 40 + dx, y: 24, text: phase.title, fontSize: 30, strokeColor: "#1e1e1e" }));
  els.push(textEl({ id: pid("subtitle"), x: 40 + dx, y: 72, text: phase.subtitle, fontSize: 18, strokeColor: "#555555" }));

  for (const b of boxes.values()) {
    const [fill, stroke] = FILL[b.kind];
    const st = status.get(b.id);
    const rect = base({
      type: b.shape ?? "rectangle", id: pid(b.id), x: b.x + dx, y: b.y, width: b.w, height: b.h,
      backgroundColor: fill, strokeColor: st === "new" ? "#2b8a3e" : st === "changed" ? "#e8590c" : stroke,
      strokeWidth: st ? 4 : 2, strokeStyle: b.kind === "note" ? "dashed" : "solid", roundness: { type: 3 },
    });
    const lines = b.text.split("\n");
    const tw = Math.max(...lines.map((l) => l.length)) * FS * 0.55;
    const th = lines.length * FS * 1.25;
    const label = textEl({
      id: pid(`${b.id}-label`), x: b.x + dx + (b.w - tw) / 2, y: b.y + (b.h - th) / 2, text: b.text, containerId: rect.id,
      textAlign: b.kind === "note" ? "left" : "center", verticalAlign: "middle", width: tw, height: th,
    });
    rect.boundElements.push({ type: "text", id: label.id });
    els.push(rect, label);
    byId.set(b.id, rect);
    if (st) {
      els.push(textEl({
        id: pid(`${b.id}-tag`), x: b.x + dx + b.w - (st === "new" ? 44 : 84), y: b.y - 22, text: st === "new" ? "NEW" : "CHANGED",
        fontSize: 16, strokeColor: st === "new" ? "#2b8a3e" : "#e8590c",
      }));
    }
  }

  for (const a of arrows.values()) {
    const f = byId.get(a.from), t = byId.get(a.to);
    if (!f || !t) continue;
    const sx = f.x + a.fp[0] * f.width, sy = f.y + a.fp[1] * f.height;
    const ex = t.x + a.tp[0] * t.width, ey = t.y + a.tp[1] * t.height;
    const ar = base({
      type: "arrow", id: pid(a.id), x: sx, y: sy, width: Math.abs(ex - sx), height: Math.abs(ey - sy), points: [[0, 0], [ex - sx, ey - sy]],
      lastCommittedPoint: null, startArrowhead: null, endArrowhead: "arrow", elbowed: false, roundness: { type: 2 },
      strokeStyle: a.dashed ? "dashed" : "solid", strokeColor: a.phase === n && n > 1 ? "#2b8a3e" : "#1e1e1e",
      startBinding: { elementId: f.id, focus: 0, gap: 4 }, endBinding: { elementId: t.id, focus: 0, gap: 4 },
    });
    f.boundElements.push({ type: "arrow", id: ar.id });
    t.boundElements.push({ type: "arrow", id: ar.id });
    els.push(ar);
    if (a.label) {
      const lt = textEl({ id: pid(`${a.id}-label`), x: (sx + ex) / 2 - a.label.length * 4.4, y: (sy + ey) / 2 - 11, text: a.label, fontSize: 16, containerId: ar.id, textAlign: "center", verticalAlign: "middle" });
      ar.boundElements.push({ type: "text", id: lt.id });
      els.push(lt);
    }
  }

  // legend
  const maxY = Math.max(...[...boxes.values()].map((b) => b.y + b.h));
  const ly = maxY + 50;
  if (n > 1) {
    els.push(base({ type: "rectangle", id: pid("lg-new"), x: 40 + dx, y: ly, width: 36, height: 22, strokeColor: "#2b8a3e", strokeWidth: 4, roundness: { type: 3 } }));
    els.push(textEl({ id: pid("lg-new-t"), x: 86 + dx, y: ly, text: "new in this phase", fontSize: 16, strokeColor: "#2b8a3e" }));
    els.push(base({ type: "rectangle", id: pid("lg-chg"), x: 280 + dx, y: ly, width: 36, height: 22, strokeColor: "#e8590c", strokeWidth: 4, roundness: { type: 3 } }));
    els.push(textEl({ id: pid("lg-chg-t"), x: 326 + dx, y: ly, text: "changed in this phase", fontSize: 16, strokeColor: "#e8590c" }));
  }
  const colors = [["ui", "client"], ["agent", "agent core"], ["memory", "memory & data"], ["model", "model"], ["tool", "search / tools"]];
  colors.forEach(([k, name], i) => {
    const x = 560 + dx + i * 175;
    els.push(base({ type: "rectangle", id: pid(`lg-${k}`), x, y: ly, width: 36, height: 22, backgroundColor: FILL[k][0], strokeColor: FILL[k][1], roundness: { type: 3 } }));
    els.push(textEl({ id: pid(`lg-${k}-t`), x: x + 44, y: ly, text: name, fontSize: 16, strokeColor: "#495057" }));
  });
  return els;
}

const file = (elements) => ({ type: "excalidraw", version: 2, source: "https://excalidraw.com", elements, appState: { viewBackgroundColor: "#ffffff", gridSize: null }, files: {} });

for (const p of PHASES) fs.writeFileSync(path.join(OUT, `${p.slug}.excalidraw`), JSON.stringify(file(nativeElements(p.n)), null, 1));
fs.writeFileSync(path.join(OUT, "architecture-evolution.excalidraw"), JSON.stringify(file(PHASES.flatMap((p, i) => nativeElements(p.n, i * 1750))), null, 1));
console.log(`wrote ${PHASES.length + 1} .excalidraw files to ${path.relative(process.cwd(), OUT)}`);

// ---- animated "evolution" view for the Excalidraw connector (simplified element format) ----
const viewIdx = process.argv.indexOf("--view");
if (viewIdx > 0) {
  const PHASE_STROKE = { 1: "#1e1e1e", 2: "#1971c2", 3: "#7048e8", 4: "#2b8a3e" };
  const v = [];
  const cam = (x, y, w) => v.push({ type: "cameraUpdate", width: w, height: (w * 3) / 4, x, y });
  const drawn = new Map(); // box id -> current view id
  let titleId = null;
  for (const p of PHASES) {
    const { boxes, arrows } = stateAt(p.n);
    cam(-40, -20, 1600);
    if (titleId) v.push({ type: "delete", ids: `${titleId},${titleId}s` });
    titleId = `t${p.n}`;
    v.push({ type: "text", id: titleId, x: 40, y: 24, text: p.title, fontSize: 30 });
    v.push({ type: "text", id: `${titleId}s`, x: 40, y: 72, text: p.subtitle, fontSize: 18, strokeColor: "#555555" });
    const touched = [...p.boxes.filter((b) => !b.only || b.only.includes(p.n)).map((b) => b.id), ...Object.keys(p.changes ?? {})];
    // Phase 2+ removes the Phase 0 note to make room.
    if (p.n === 2 && drawn.has("p0")) {
      v.push({ type: "delete", ids: drawn.get("p0") });
      drawn.delete("p0");
    }
    for (const id of touched) {
      const b = boxes.get(id);
      if (!b) continue;
      if (drawn.has(id)) v.push({ type: "delete", ids: drawn.get(id) });
      const vid = `${id}_${p.n}`;
      drawn.set(id, vid);
      v.push({
        type: b.shape ?? "rectangle", id: vid, x: b.x, y: b.y, width: b.w, height: b.h, roundness: { type: 3 },
        backgroundColor: FILL[b.kind][0], fillStyle: "solid", strokeColor: PHASE_STROKE[b.changedIn ?? b.phase], strokeWidth: p.n > 1 ? 3 : 2,
        strokeStyle: b.kind === "note" ? "dashed" : "solid", label: { text: b.text, fontSize: FS },
      });
      if (p.n > 1) v.push({ type: "text", id: `${vid}tag`, x: b.x + b.w - 30, y: b.y - 22, text: `P${p.n}`, fontSize: 16, strokeColor: PHASE_STROKE[p.n] });
    }
    for (const a of arrows.values()) {
      if (a.phase !== p.n && !(p.arrowLabels ?? {})[a.id] && !touched.includes(a.from) && !touched.includes(a.to)) continue;
      const f = boxes.get(a.from), t = boxes.get(a.to);
      if (!f || !t) continue;
      const sx = f.x + a.fp[0] * f.w, sy = f.y + a.fp[1] * f.h, ex = t.x + a.tp[0] * t.w, ey = t.y + a.tp[1] * t.h;
      const aid = `${a.id}_${p.n}`;
      if (drawn.has(a.id)) v.push({ type: "delete", ids: drawn.get(a.id) });
      drawn.set(a.id, aid);
      v.push({
        type: "arrow", id: aid, x: sx, y: sy, width: Math.abs(ex - sx), height: Math.abs(ey - sy), points: [[0, 0], [ex - sx, ey - sy]],
        endArrowhead: "arrow", strokeColor: PHASE_STROKE[a.phase], strokeStyle: a.dashed ? "dashed" : "solid",
        ...(a.label ? { label: { text: a.label, fontSize: 16 } } : {}),
      });
    }
  }
  // legend
  const ly = 1010;
  [[1, "Phase 0-1 skeleton"], [2, "P2 persistence + time"], [3, "P3 temporal memory"], [4, "P4 evidence ledger"]].forEach(([n, name], i) => {
    v.push({ type: "rectangle", id: `lg${n}`, x: 40 + i * 330, y: ly, width: 36, height: 22, strokeColor: PHASE_STROKE[n], strokeWidth: 3, roundness: { type: 3 } });
    v.push({ type: "text", id: `lg${n}t`, x: 86 + i * 330, y: ly, text: name, fontSize: 18, strokeColor: PHASE_STROKE[n] });
  });
  cam(-40, -20, 1600);
  fs.writeFileSync(process.argv[viewIdx + 1], JSON.stringify(v));
  console.log(`wrote connector view (${v.length} elements) to ${process.argv[viewIdx + 1]}`);
}
