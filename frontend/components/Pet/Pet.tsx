"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PetState } from "@/types/contract";

/* ==================================================================
   boxcat 像素桌宠
   ------------------------------------------------------------------
   图集 boxcat.webp：1536×1872，8 列 × 9 行，单格 192×208
   9 行（row 0~8）：idle / running-right / running-left / waving /
                    jumping / failed / waiting / running / review
   各行帧数 [6,8,8,4,5,8,6,6,6]（不能硬编码 8）
   头顶道具用与图集同一张逻辑网格的 overlay 画布（192×264，向上多 56）
   ================================================================== */

const CW = 192;
const CH = 208;
const OY = 56; // overlay 画布向上多出的 56px
const OV_H = 264; // overlay 画布高
const BOX_W = 288; // 组件逻辑宽（内层固定 288×380，整体缩放）

const ACTIONS = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
];
const ROW_FRAMES = [6, 8, 8, 4, 5, 8, 6, 6, 6];
const ROW_DUR: Record<string, number> = {
  idle: 1500,
  "running-right": 480,
  "running-left": 480,
  waving: 560,
  jumping: 720,
  failed: 620,
  waiting: 860,
  running: 760,
  review: 800,
};
const ROW_INDEX: Record<string, number> = {};
ACTIONS.forEach((a, i) => {
  ROW_INDEX[a] = i;
});

type FxKind = "scope" | "alert" | "confused" | "excited";

interface StateSpec {
  row: string;
  label: string;
  body: string;
  fx?: FxKind;
}

/* 可播放的视觉状态：契约 7 状态 + 待机巡逻专用的左右走（仅 A 内部视觉，契约不动） */
export type PetVisualState = PetState | "WALK_RIGHT" | "WALK_LEFT";

/* 契约 7 状态（+巡逻）→ 图集行 / 体态动画 / 头顶道具。
   THINKING 不走单行循环，而是播「掏出笔记本 → 飞速写」整套记录动画。 */
const STATE_SPEC: Record<PetVisualState, StateSpec> = {
  IDLE: { row: "idle", label: "发呆", body: "IDLE" },
  OBSERVING: { row: "idle", label: "观察中", body: "OBSERVING", fx: "scope" },
  THINKING: { row: "review", label: "记录中", body: "THINKING" },
  CURIOUS: { row: "waving", label: "好奇", body: "CURIOUS" },
  ALERT: { row: "running", label: "警戒", body: "ALERT", fx: "alert" },
  EXCITED: { row: "jumping", label: "发现新行为", body: "EXCITED", fx: "excited" },
  CONFUSED: { row: "waiting", label: "困惑", body: "CONFUSED", fx: "confused" },
  WALK_RIGHT: { row: "running-right", label: "巡逻（向右）", body: "WALK" },
  WALK_LEFT: { row: "running-left", label: "巡逻（向左）", body: "WALK" },
};

/* ==================================================================
   ① 记录动画（THINKING 的主表演）
   ================================================================== */
interface SeqStep {
  label: string;
  pet: keyof typeof PK_ROWS;
  book: "" | "half" | "hoist" | "write" | "pack";
  ms: number;
  cls?: string;
}

const SEQ: SeqStep[] = [
  { label: "待机", pet: "idle", book: "", ms: 800 },
  { label: "发觉！", pet: "waiting", book: "", ms: 180 },
  { label: "唰—", pet: "waving", book: "", ms: 200, cls: "boxcat-reach" },
  { label: "掏出来", pet: "review", book: "half", ms: 150, cls: "boxcat-bob boxcat-scribble" },
  { label: "翻开", pet: "review", book: "hoist", ms: 130, cls: "boxcat-bob boxcat-scribble" },
  { label: "飞速写", pet: "review", book: "write", ms: 1200, cls: "boxcat-bob boxcat-scribble" },
  { label: "收起", pet: "review", book: "pack", ms: 280, cls: "boxcat-bob" },
  { label: "待机", pet: "idle", book: "", ms: 1100 },
];

/* 记录动画用到的 4 行：[row, 帧数, ms/帧] */
const PK_ROWS = {
  idle: [0, 6, 700],
  waving: [3, 4, 480],
  waiting: [6, 6, 700],
  review: [8, 6, 620],
} as const;

/* ==================================================================
   调色板（主色取自图集实测高频色）
   ================================================================== */
const C = {
  edge: "#241c14",
  cream: "#FDEBC7",
  tan: "#DEA86C",
  tanHi: "#E7B172",
  dark: "#4a3a2a",
  metal: "#6b6154",
  metalHi: "#b9ad9a",
  metalLo: "#3b352c",
  cyan: "#8fd7dd",
  cyanHi: "#dff6f8",
  warn: "#ff7a4d",
  warnHi: "#ffd9c2",
  yellow: "#F2C245",
  penHi: "#fbe08a",
  wood: "#d9b483",
  ferrule: "#b9b3a8",
  eraser: "#e0a0a0",
};

const P = {
  edge: C.edge,
  board: "#c08a4e",
  boardLo: "#8f6236",
  paper: "#ffeecc",
  paperLo: "#e3cfa4",
  rule: "#dcc79a",
  ink: "#3a2c1e",
  ring: "#4a4038",
  pen: C.yellow,
  penHi: C.penHi,
  wood: C.wood,
  ferrule: C.ferrule,
  eraser: C.eraser,
  tip: C.edge,
};

/* ==================================================================
   像素绘制原语
   ================================================================== */
type Ctx = CanvasRenderingContext2D;

function fill(c: Ctx, x: number, y: number, w: number, h: number, col: string) {
  c.fillStyle = col;
  c.fillRect(x, y, w, h);
}

/* overlay：所有 y 都按「猫的图集格坐标」书写，内部统一 +OY */
function opx(gg: Ctx, x: number, y: number, w: number, h: number, col: string) {
  gg.fillStyle = col;
  gg.fillRect(Math.round(x), Math.round(y) + OY, Math.round(w), Math.round(h));
}

/* 字符画 → 像素；可选 4 向 1px 描边（描边按 k 缩放） */
function oGlyph(
  gg: Ctx,
  rows: readonly string[],
  ox: number,
  oy: number,
  k: number,
  fillCol: string,
  edgeCol?: string | null,
  alpha?: number
) {
  gg.globalAlpha = alpha === undefined ? 1 : alpha;
  if (edgeCol) {
    const d = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];
    for (let n = 0; n < 4; n++) {
      for (let j = 0; j < rows.length; j++) {
        for (let i = 0; i < rows[j].length; i++) {
          if (rows[j].charAt(i) === "#") {
            opx(gg, ox + i * k + d[n][0], oy + j * k + d[n][1], k, k, edgeCol);
          }
        }
      }
    }
  }
  for (let j = 0; j < rows.length; j++) {
    for (let i = 0; i < rows[j].length; i++) {
      if (rows[j].charAt(i) === "#") opx(gg, ox + i * k, oy + j * k, k, k, fillCol);
    }
  }
  gg.globalAlpha = 1;
}

/* 空心圆环：外半径 ro、内半径 ri，中间留空（用来画镜框，中间透出猫自己的眼睛） */
function oRing(gg: Ctx, cx: number, cy: number, ro: number, ri: number, col: string) {
  for (let dy = -ro; dy <= ro; dy++) {
    const ady = Math.abs(dy);
    const odx = Math.floor(Math.sqrt(ro * ro - dy * dy));
    if (ady <= ri) {
      const idx = Math.floor(Math.sqrt(ri * ri - dy * dy));
      const w = odx - idx;
      if (w <= 0) continue;
      opx(gg, cx - odx, cy + dy, w, 1, col);
      opx(gg, cx + idx + 1, cy + dy, w, 1, col);
    } else {
      opx(gg, cx - odx, cy + dy, odx * 2 + 1, 1, col);
    }
  }
}

function easeOutBack(t: number) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

const G_QUEST = [".###.", "#...#", "....#", "..##.", "..#..", ".....", "..#.."];
const G_BANG = ["##", "##", "##", "##", "##", "..", "..", "##", "##"];
const G_STAR = ["..#..", "..#..", "#####", "..#..", "..#.."];
const G_BULB_GLASS = [
  "..#####..",
  ".#######.",
  "#########",
  "#########",
  "#########",
  "#########",
  ".#######.",
  "..#####..",
];
const G_BULB_NECK = ["...###...", "...###...", "...###..."];
const G_BULB_BASE = [
  "..#####..",
  "..#.#.#..",
  "..#####..",
  "..#.#.#..",
  "..#####..",
  "..#####..",
];

/* ==================================================================
   头顶道具 overlay
   ================================================================== */

/* --- OBSERVING：圆框呆萌眼镜（戴在猫眼上 左 69,81 / 右 123,81）
   设计要点：只画「镜框 + 镜腿 + 鼻梁桥 + 一点镜片反光」，镜片中间完全留空，
   让猫自己的眼睛透出来——避免「眼球上又长了一双眼睛」的惊悚观感；
   整副眼镜缓慢左右扫视，配上猫脸，一眼就能读成「它正盯着屏幕外的人类看」。 --- */
function drawScope(gg: Ctx, now: number) {
  const CYCLE = 6400;
  const IN = 300;
  const OUT = 420;
  const cyc = now % CYCLE;
  let s: number;
  if (cyc < IN) s = easeOutBack(cyc / IN);
  else if (cyc > CYCLE - OUT) {
    const t = (cyc - (CYCLE - OUT)) / OUT;
    s = 1 - t * t;
  } else s = 1;
  if (s <= 0.03) return;

  const LX = 69; // 左眼镜片中心
  const RX = 123; // 右眼镜片中心
  const R = 15; // 镜片半径
  const LY = 81 + Math.sin(now / 780) * 1.1; // 轻轻起伏
  const swing = Math.sin(now / 1150) * 1.9; // 整副眼镜左右扫视

  gg.save();
  gg.translate(96, LY);
  gg.scale(s, s);
  gg.translate(-96, -LY);
  gg.translate(swing, 0);

  /* 镜腿：两小段伸向耳侧，坐实「戴在脸上」 */
  opx(gg, LX - R - 12, LY - 3, 14, 6, C.edge);
  opx(gg, LX - R - 11, LY - 2, 12, 4, C.tan);
  opx(gg, RX + R - 2, LY - 3, 14, 6, C.edge);
  opx(gg, RX + R - 1, LY - 2, 12, 4, C.tan);

  /* 鼻梁桥 */
  const bridgeW = RX - R - (LX + R) + 8;
  opx(gg, LX + R - 4, LY - 3, bridgeW, 6, C.edge);
  opx(gg, LX + R - 3, LY - 2, bridgeW - 2, 4, C.tanHi);

  for (let i = 0; i < 2; i++) {
    const bx = i ? RX : LX;
    /* 只有镜框：空心圆环，中间不填充 → 猫自己的眼睛原样透出来 */
    oRing(gg, bx, LY, R, R - 3, C.edge); // 深色外镜框
    oRing(gg, bx, LY, R - 3, R - 4, C.tanHi); // 内侧一圈高光，做出镜框厚度
    /* 镜片左上角一点斜向反光（是玻璃反光，不是眼睛） */
    opx(gg, bx - 6, LY - 6, 3, 1, C.cream);
    opx(gg, bx - 5, LY - 5, 1, 2, C.cream);
  }

  gg.restore();
}

/* --- ALERT：头顶一个大感叹号，260ms「弹进来」+ 1400ms 慢闪 + 2px 轻浮动 --- */
function drawAlert(gg: Ctx, now: number) {
  /* 进入动画：从上方压着 easeOutBack 弹下，避免凭空闪现 */
  const t = Math.min(1, now / 260);
  const pop = easeOutBack(t);
  const a = Math.min(1, now / 170);
  const on = now % 1400 < 940;
  const blink = (on ? 1 : 0.22) * a;
  const dy = -46 + (1 - pop) * -26 + Math.sin(now / 900) * 2;
  oGlyph(gg, G_BANG, 91, dy, 5, C.warn, C.edge, blink);
  oGlyph(gg, G_BANG, 93, dy + 3, 3, C.warnHi, null, blink);
}

/* --- CONFUSED：三个大小不一的问号，错开 90ms 依次浮出，各飘各的 --- */
function drawConfused(gg: Ctx, now: number) {
  const items = [
    { x: 118, y: -34, k: 3, ph: 0 },
    { x: 58, y: -20, k: 2, ph: 1.9 },
    { x: 152, y: 2, k: 2, ph: 3.4 },
  ];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const t = Math.min(1, Math.max(0, (now - i * 90) / 300));
    if (t <= 0) continue;
    const pop = easeOutBack(t);
    const dy = Math.sin(now / 560 + it.ph) * 4 + (1 - pop) * 12;
    oGlyph(gg, G_QUEST, it.x, it.y + dy, it.k, C.cream, C.edge, 0.95 * Math.min(1, t * 1.5));
  }
}

/* --- EXCITED：放慢的星芒 + 每 3000ms「突然点亮」的像素小灯泡 --- */
function drawBulb(gg: Ctx, now: number) {
  const CYCLE = 3000;
  const OUT = 420;
  const cyc = now % CYCLE;
  let a: number;
  if (cyc < 140) a = cyc / 140;
  else if (cyc > CYCLE - OUT) a = (CYCLE - cyc) / OUT;
  else a = 1;
  if (a <= 0.02) return;

  const bx = 18;
  const by = -48;
  const k = 2;
  const on = a > 0.55;
  oGlyph(gg, G_BULB_GLASS, bx, by, k, on ? C.yellow : C.metalHi, C.edge, a);
  oGlyph(gg, G_BULB_NECK, bx, by + 8 * k, k, C.metal, C.edge, a);
  oGlyph(gg, G_BULB_BASE, bx, by + 11 * k, k, C.metalHi, C.edge, a);

  const bcx = bx + 4.5 * k;
  const bcy = by + 4 * k;
  gg.globalAlpha = a;
  opx(gg, bx + 3 * k, by + 3 * k, k, 3 * k, C.warn);
  opx(gg, bx + 4 * k, by + 4 * k, k, 2 * k, C.warn);
  opx(gg, bx + 5 * k, by + 3 * k, k, 3 * k, C.warn);
  opx(gg, bx + 2 * k, by + 2 * k, k, k, C.cream);
  gg.globalAlpha = 1;

  if (on) {
    const dirs = [
      [0, -1],
      [1, -1],
      [1, 0],
      [1, 1],
      [0, 1],
      [-1, 1],
      [-1, 0],
      [-1, -1],
    ];
    const flick = 0.45 + 0.55 * Math.abs(Math.sin(now / 280));
    gg.globalAlpha = a * flick;
    for (let i = 0; i < 8; i++) {
      const d = dirs[i];
      const rr = 12 + (i % 2) * 2;
      opx(gg, bcx + d[0] * rr - 1, bcy + d[1] * rr - 1, 2, 2, C.yellow);
    }
    gg.globalAlpha = 1;
  }
}

function drawExcited(gg: Ctx, now: number) {
  const items = [
    { x: 52, y: -30, k: 2, ph: 0 },
    { x: 132, y: -14, k: 2, ph: 1.3 },
    { x: 22, y: 8, k: 2, ph: 2.4 },
    { x: 158, y: 30, k: 2, ph: 3.6 },
    { x: 92, y: -44, k: 1, ph: 0.7 },
  ];
  const ea = Math.min(1, now / 340); // 星芒整体淡入
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const s = (0.6 + 0.4 * Math.abs(Math.sin(now / 620 + it.ph))) * ea;
    const col = i % 2 ? C.yellow : C.cyanHi;
    oGlyph(gg, G_STAR, it.x, it.y, it.k, col, C.edge, s);
  }
  drawBulb(gg, now);
}

function drawOverlay(gg: Ctx, kind: FxKind, now: number) {
  gg.clearRect(0, 0, CW, OV_H);
  if (kind === "scope") drawScope(gg, now);
  else if (kind === "alert") drawAlert(gg, now);
  else if (kind === "confused") drawConfused(gg, now);
  else if (kind === "excited") drawExcited(gg, now);
}

/* ==================================================================
   笔记本 + 像素笔 + 像素烟
   ================================================================== */
const PC_OY = 8; // 铅笔画布比 #cv 向上多 8 逻辑格

function ppx(pg: Ctx, x: number, y: number, w: number, h: number, col: string) {
  pg.fillStyle = col;
  pg.fillRect(Math.round(x), Math.round(y) + PC_OY, Math.round(w), Math.round(h));
}

const TEXT = [
  { x: 7, y: 10, n: 14 },
  { x: 7, y: 14, n: 12 },
  { x: 7, y: 18, n: 13 },
  { x: 7, y: 22, n: 9 },
  { x: 28, y: 10, n: 13 },
  { x: 28, y: 14, n: 12 },
  { x: 28, y: 18, n: 11 },
];

/* 13 格长、朝右上 45° 斜出的像素铅笔；画在更大的 #pc 图层上以免被裁 */
function drawPencil(pg: Ctx, bx: number, by: number) {
  for (let k = -1; k <= 13; k++) ppx(pg, bx + k, by - k - 1, 1, 4, P.edge);
  for (let k = 0; k <= 13; k++) {
    let col = P.pen;
    if (k <= 1) col = P.tip;
    else if (k === 2) col = P.wood;
    else if (k === 10) col = P.ferrule;
    else if (k >= 11) col = P.eraser;
    ppx(pg, bx + k, by - k, 1, 2, col);
  }
  for (let k = 4; k <= 9; k++) ppx(pg, bx + k, by - k, 1, 1, P.penHi);
}

function drawBook(g: Ctx, pg: Ctx, wp: number, now: number) {
  g.clearRect(0, 0, 50, 34);
  pg.clearRect(0, 0, 58, 42);

  fill(g, 2, 2, 46, 30, P.board);
  fill(g, 2, 29, 46, 3, P.boardLo);
  fill(g, 45, 2, 3, 30, P.boardLo);
  fill(g, 2, 2, 46, 1, P.edge);
  fill(g, 2, 31, 46, 1, P.edge);
  fill(g, 2, 2, 1, 30, P.edge);
  fill(g, 47, 2, 1, 30, P.edge);

  fill(g, 6, 5, 18, 24, P.paper);
  fill(g, 26, 5, 19, 24, P.paper);
  fill(g, 23, 5, 1, 24, P.paperLo);
  fill(g, 26, 5, 1, 24, P.paperLo);
  fill(g, 24, 4, 2, 26, P.edge);

  for (let i = 0; i < 4; i++) {
    const y = 12 + i * 4;
    fill(g, 7, y, 16, 1, P.rule);
    fill(g, 28, y, 16, 1, P.rule);
  }
  for (let i = 0; i < 5; i++) {
    const y = 6 + i * 5;
    fill(g, 0, y, 5, 1, P.ring);
    fill(g, 0, y + 1, 5, 1, P.edge);
  }

  /* 逐行逐格写出的手写实录 */
  let cur = -1;
  for (let i = 0; i < TEXT.length; i++) {
    const t = TEXT[i];
    const p = wp * TEXT.length - i;
    const n = Math.round(t.n * Math.max(0, Math.min(1, p)));
    for (let k = 0; k < n; k++) {
      fill(g, t.x + k, t.y, 1, 1, P.ink);
      if (k % 4 < 2) fill(g, t.x + k, t.y + 1, 1, 1, P.ink);
    }
    if (p > 0 && p < 1) cur = i;
  }

  if (cur >= 0) {
    const t = TEXT[cur];
    const n = Math.round(t.n * (wp * TEXT.length - cur));
    const j = Math.floor(now / 55) % 2 ? 0 : 1;
    drawPencil(pg, t.x + n, t.y + j);
  }
}

/* ---------- 像素烟：160×100 逻辑格（1 格 = 舞台 3px） ---------- */
const FW = 160;
const FH = 100;

interface Puff {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  max: number;
  a0: number;
}

interface Anim {
  wp: number;
  wpFrom: number;
  wpTo: number;
  wpStart: number;
  wpDur: number;
  puffs: Puff[];
  emitOn: boolean;
  emitAcc: number;
}

function newAnim(): Anim {
  return { wp: 0, wpFrom: 0, wpTo: 0, wpStart: 0, wpDur: 0, puffs: [], emitOn: false, emitAcc: 0 };
}

function puff(a: Anim, x: number, y: number, vx: number, vy: number) {
  a.puffs.push({ x, y, vx, vy, age: 0, max: 900 + Math.random() * 500, a0: 0.18 + Math.random() * 0.12 });
  if (a.puffs.length > 14) a.puffs.shift();
}

function spawnPuff(a: Anim) {
  const side = Math.random() < 0.5 ? -1 : 1;
  puff(
    a,
    80 + side * (36 + Math.random() * 6),
    80 + Math.random() * 6,
    side * (1.2 + Math.random() * 1.4),
    -(9 + Math.random() * 6)
  );
}

function burstPuffs(a: Anim, n: number) {
  for (let i = 0; i < n; i++) {
    const side = i % 2 ? 1 : -1;
    puff(a, 80 + side * (30 + Math.random() * 10), 74 + Math.random() * 8, side * (2 + Math.random() * 2), -(12 + Math.random() * 6));
  }
}

function updatePuffs(a: Anim, dt: number) {
  const s = dt / 1000;
  for (let i = a.puffs.length - 1; i >= 0; i--) {
    const p = a.puffs[i];
    p.age += dt;
    if (p.age >= p.max) {
      a.puffs.splice(i, 1);
      continue;
    }
    p.x += p.vx * s;
    p.y += p.vy * s;
    p.vy *= 0.994;
    p.vx *= 0.98;
  }
}

function drawPuffs(fg: Ctx, a: Anim) {
  fg.clearRect(0, 0, FW, FH);
  for (let i = 0; i < a.puffs.length; i++) {
    const p = a.puffs[i];
    const t = p.age / p.max;
    const alpha = p.a0 * Math.min(1, t * 5) * (1 - t);
    if (alpha <= 0.004) continue;
    const u = 2 + Math.floor(t * 2.4);
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    fg.fillStyle = "rgba(214,206,190," + alpha.toFixed(3) + ")";
    fg.fillRect(x, y, u, u);
    fg.fillRect(x + u, y, u, u);
    fg.fillRect(x + Math.round(u / 2), y - u, u, u);
    fg.fillStyle = "rgba(150,140,125," + (alpha * 0.8).toFixed(3) + ")";
    fg.fillRect(x, y + u, u, u);
    fg.fillRect(x + u, y + u, u, u);
  }
}

/* ==================================================================
   CSS（模块级生成一次，注入 <head>）
   ================================================================== */
let cachedCss: string | null = null;

function buildCss(): string {
  if (cachedCss) return cachedCss;
  let css = "";

  /* 舞台盒：外层按 288:380 自适应，内层固定 288×380 再整体缩放 */
  css += ".boxcat{position:relative;width:100%;aspect-ratio:288/380;}";
  css += ".boxcat-scale{position:absolute;top:0;left:0;width:288px;height:380px;transform-origin:top left;}";
  css += ".boxcat-stage{position:absolute;left:0;bottom:0;width:288px;height:300px;}";
  css +=
    ".boxcat-petwrap{position:absolute;left:50%;bottom:0;width:192px;height:208px;" +
    "transform:translateX(-50%) scale(1.35);transform-origin:bottom center;z-index:4;" +
    "transition:transform .34s cubic-bezier(.3,.9,.4,1);will-change:transform;}";
  css += ".boxcat-cell{position:relative;width:192px;height:208px;transform-origin:bottom center;}";
  css +=
    ".boxcat-sprwrap{position:relative;width:192px;height:208px;" +
    "animation:boxcat-enter .3s cubic-bezier(.2,.9,.3,1) both;}";
  css +=
    "@keyframes boxcat-enter{0%{opacity:0;transform:translateY(8px) scale(.93);}" +
    "55%{opacity:1;}100%{opacity:1;transform:none;}}";
  css +=
    '.boxcat-sprite{width:192px;height:208px;background-image:url("/boxcat.webp");' +
    "background-repeat:no-repeat;background-size:1536px 1872px;image-rendering:pixelated;}";
  css +=
    ".boxcat-ov{position:absolute;left:0;top:-56px;width:192px;height:264px;" +
    "image-rendering:pixelated;pointer-events:none;}";

  /* 笔记本 */
  css +=
    ".boxcat-book{position:absolute;left:144px;bottom:26px;width:150px;height:102px;" +
    "transform-origin:center bottom;transform:translateX(-50%) perspective(430px) rotateX(40deg) scale(.95);" +
    "opacity:0;z-index:6;will-change:transform;" +
    "transition:transform .17s cubic-bezier(.2,1.5,.35,1),bottom .17s cubic-bezier(.2,1.5,.35,1),opacity .1s ease;}";
  css +=
    ".boxcat-book-half{bottom:58px;transform:translateX(-50%) perspective(430px) rotateX(62deg) scale(.5);opacity:.95;z-index:2;}";
  css +=
    ".boxcat-book-hoist{transform:translateX(-50%) perspective(430px) rotateX(10deg) scale(.95);opacity:1;z-index:6;}";
  css +=
    ".boxcat-book-write{transform:translateX(-50%) perspective(430px) rotateX(40deg) scale(.95);opacity:1;z-index:6;}";
  css +=
    ".boxcat-book-pack{bottom:58px;transform:translateX(-50%) perspective(430px) rotateX(68deg) scale(.42);opacity:0;z-index:2;" +
    "transition:transform .22s cubic-bezier(.5,0,.78,.28),bottom .22s cubic-bezier(.5,0,.78,.28),opacity .14s ease .06s;}";
  css +=
    ".boxcat-bookcv{display:block;width:150px;height:102px;image-rendering:pixelated;" +
    "filter:drop-shadow(0 4px 6px rgba(0,0,0,.5));}";
  css +=
    ".boxcat-pencil{position:absolute;left:0;top:-24px;width:174px;height:126px;" +
    "image-rendering:pixelated;pointer-events:none;}";
  css +=
    ".boxcat-fx{position:absolute;left:50%;top:0;transform:translateX(-50%);width:480px;height:300px;" +
    "image-rendering:pixelated;z-index:7;pointer-events:none;}";

  /* 记录动画的外层体态（自带完整 transform，所以放在 petwrap 上） */
  css += ".boxcat-petwrap.boxcat-reach{transform:translateX(-50%) scale(1.36) translateY(-3px);}";
  css += ".boxcat-petwrap.boxcat-bob{animation:boxcat-breathe 1.5s ease-in-out infinite;}";
  css += ".boxcat-petwrap.boxcat-scribble{animation:boxcat-scribble .13s linear infinite;}";
  css +=
    "@keyframes boxcat-breathe{0%,100%{transform:translateX(-50%) scale(1.36) translateY(-3px);}" +
    "50%{transform:translateX(-50%) scale(1.36) translateY(-5px);}}";
  css +=
    "@keyframes boxcat-scribble{0%,49%{transform:translateX(-50%) scale(1.36) translate(-1px,-3px);}" +
    "50%,100%{transform:translateX(-50%) scale(1.36) translate(1px,-5px);}}";

  /* 图集逐行播放 */
  ACTIONS.forEach((a, i) => {
    const n = ROW_FRAMES[i];
    css +=
      "@keyframes boxcat-pr" + i + "{from{background-position-x:0}to{background-position-x:" + -n * CW + "px;}}";
    css +=
      ".boxcat-a" + i + "{animation:boxcat-pr" + i + " " + ROW_DUR[a] + "ms steps(" + n + ") infinite;" +
      "background-position-y:" + -i * CH + "px;}";
  });

  /* 记录动画用到的 4 行 */
  (Object.keys(PK_ROWS) as (keyof typeof PK_ROWS)[]).forEach((key) => {
    const [row, n, dur] = PK_ROWS[key];
    css +=
      "@keyframes boxcat-pk-" + key + "{from{background-position-x:0}to{background-position-x:" + -n * CW + "px;}}";
    css +=
      ".boxcat-pk-" + key + "{animation:boxcat-pk-" + key + " " + dur + "ms steps(" + n + ") infinite;" +
      "background-position-y:" + -row * CH + "px;}";
  });

  /* 各状态整体体态（刻意放慢；只写 translate/rotate/scale，所以放在内层 cell 上） */
  css += ".boxcat-s-IDLE{animation:boxcat-bobk 2.8s ease-in-out infinite;}";
  css += ".boxcat-s-OBSERVING{animation:boxcat-lean 3.6s ease-in-out infinite;}";
  css += ".boxcat-s-CURIOUS{animation:boxcat-crane 3.4s ease-in-out infinite;}";
  css += ".boxcat-s-ALERT{animation:none;}";
  css += ".boxcat-s-EXCITED{animation:boxcat-jump 1.5s cubic-bezier(.3,0,.4,1) infinite;}";
  css += ".boxcat-s-CONFUSED{animation:boxcat-wobble 3.6s ease-in-out infinite;}";
  css += ".boxcat-s-WALK{animation:boxcat-trot .46s ease-in-out infinite;}";
  css +=
    "@keyframes boxcat-bobk{0%,100%{transform:translateY(0) scaleY(1);}50%{transform:translateY(-6px) scaleY(1.03);}}";
  css +=
    "@keyframes boxcat-lean{0%,100%{transform:translateY(0) rotate(0deg);}" +
    "50%{transform:translateY(-2px) rotate(-3deg) scale(1.03);}}";
  css +=
    "@keyframes boxcat-crane{0%,100%{transform:translateY(0) rotate(0deg) scale(1);}" +
    "50%{transform:translateY(-4px) rotate(-2.5deg) scale(1.02);}}";
  css +=
    "@keyframes boxcat-jump{0%,100%{transform:translateY(0) scaleY(1) scaleX(1);}" +
    "15%{transform:translateY(0) scaleY(.88) scaleX(1.10);}" +
    "45%{transform:translateY(-30px) scaleY(1.08) scaleX(.95);}" +
    "75%{transform:translateY(0) scaleY(.91) scaleX(1.07);}}";
  css +=
    "@keyframes boxcat-wobble{0%,100%{transform:rotate(0deg);}25%{transform:rotate(-3.5deg);}" +
    "60%{transform:rotate(3deg);}80%{transform:rotate(-1.5deg);}}";
  css += "@keyframes boxcat-trot{0%,100%{transform:translateY(0);}50%{transform:translateY(-2px);}}";

  /* 无障碍：尊重系统「减少动态效果」 */
  css +=
    "@media (prefers-reduced-motion: reduce){" +
    ".boxcat-petwrap,.boxcat-cell,.boxcat-sprwrap,.boxcat-sprite,.boxcat-book,.boxcat-ov{animation:none!important;transition:none!important;}}";

  cachedCss = css;
  return css;
}

const STYLE_ID = "boxcat-sprite-css";

/* 系统「减少动态」偏好：用 useSyncExternalStore 订阅，避免在 effect 里同步 setState */
function subscribeReducedMotion(cb: () => void) {
  const m = window.matchMedia("(prefers-reduced-motion: reduce)");
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}
function getReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* ==================================================================
   组件
   ================================================================== */
interface PetProps {
  pet_state?: PetVisualState;
}

/* 换动作的节奏（ms）：
   - 记录（THINKING）刻意走「快」：不桥接、立刻切，强调「飞速记录」；
   - 其余动作走「稳」：目标态先连续稳定 SETTLE_MS 才起手，随后在「发呆」上停
     BRIDGE_MS 再切过去，且一个动作至少演 MIN_HOLD_MS 才允许被下一个打断。
   这样既保持「都以发呆为基准起手」，又避免 B 连续下发时高频硬切、看起来鬼畜。 */
const SETTLE_MS = 180;
const BRIDGE_MS = 380;
const MIN_HOLD_MS = 900;

export function Pet({ pet_state = "IDLE" }: PetProps) {
  /* shown 是「此刻真正在演的状态」。非记录态永远先经过 IDLE 再到目标状态。 */
  const [shown, setShown] = useState<PetVisualState>(pet_state);
  const spec = STATE_SPEC[shown];
  const isThinking = shown === "THINKING";
  const reduced = useSyncExternalStore(subscribeReducedMotion, getReducedMotion, () => false);

  /* 当前真正在演的状态 + 它的最短驻留截止时间（用 ref 保存，避免把节流逻辑塞进依赖） */
  const shownRef = useRef<PetVisualState>(pet_state);
  const holdUntilRef = useRef(0);
  const showNow = useCallback((s: PetVisualState) => {
    shownRef.current = s;
    setShown(s);
    holdUntilRef.current = s === "IDLE" ? 0 : performance.now() + MIN_HOLD_MS;
  }, []);

  /* 状态桥接：THINKING 立刻切；其余先稳定、再回发呆、再切目标。
     全部 setState 都放在定时器回调里，遵守 react-hooks/set-state-in-effect。 */
  useEffect(() => {
    if (pet_state === shownRef.current) return;
    if (pet_state === "THINKING") {
      const t = window.setTimeout(() => showNow(pet_state), 0);
      return () => window.clearTimeout(t);
    }
    /* 目标态要先稳定住，才值得起手；抖动窗口内再次变化就重新计时（吸收抖动的关键） */
    const timers: number[] = [];
    const settle = window.setTimeout(() => {
      /* 若正在演别的动作，至少演够 MIN_HOLD_MS 才允许被打断 */
      const holdLeft = Math.max(0, holdUntilRef.current - performance.now());
      const toIdle = shownRef.current === "IDLE" ? 0 : Math.max(SETTLE_MS, holdLeft);
      timers.push(
        window.setTimeout(() => {
          showNow("IDLE");
          timers.push(window.setTimeout(() => showNow(pet_state), BRIDGE_MS));
        }, toIdle),
      );
    }, SETTLE_MS);
    timers.push(settle);
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [pet_state, showNow]);

  const boxRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const bookRef = useRef<HTMLCanvasElement>(null);
  const pencilRef = useRef<HTMLCanvasElement>(null);
  const smokeRef = useRef<HTMLCanvasElement>(null);

  const [scale, setScale] = useState(1);
  const [phase, setPhase] = useState(0);
  // 减少动态时，THINKING 固定停在「飞速写」那一帧（SEQ 第 5 项），由渲染派生而非在 effect 里同步 setState
  const effPhase = reduced && isThinking ? 5 : phase;

  /* 1) 注入样式（只注入一次，多个实例共用） */
  useEffect(() => {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = buildCss();
    document.head.appendChild(el);
  }, []);

  /* 2) 量宽自适应：外层按 288:380，内层固定 288×380 再整体缩放 */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const update = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setScale(w / BOX_W);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* 3) 动画主循环：overlay 重绘（非 THINKING）或记录动画时间线（THINKING） */
  useEffect(() => {
    const overlayG = overlayRef.current ? overlayRef.current.getContext("2d") : null;
    const bookG = bookRef.current ? bookRef.current.getContext("2d") : null;
    const pencilG = pencilRef.current ? pencilRef.current.getContext("2d") : null;
    const smokeG = smokeRef.current ? smokeRef.current.getContext("2d") : null;

    const anim = newAnim();

    /* --- 减少动态：只画一帧静态图（姿势由渲染侧的 effPhase 决定） --- */
    if (reduced) {
      if (isThinking) {
        anim.wp = 1;
        if (bookG && pencilG) drawBook(bookG, pencilG, 1, 700);
      } else if (overlayG && spec.fx) {
        drawOverlay(overlayG, spec.fx, 700);
      }
      return;
    }

    let raf = 0;
    let cancelled = false;
    const timers: number[] = [];

    /* --- THINKING：时间线驱动的记录动画 --- */
    if (isThinking) {
      let t = 0;
      const run = () => {
        SEQ.forEach((s, i) => {
          timers.push(
            window.setTimeout(() => {
              if (cancelled) return;
              setPhase(i);
              if (s.book === "write") {
                anim.wpFrom = anim.wp;
                anim.wpTo = 1;
                anim.wpStart = performance.now();
                anim.wpDur = 850;
                anim.emitOn = true;
              } else {
                anim.wp = 0;
                anim.wpDur = 0;
                anim.emitOn = false;
                anim.emitAcc = 0;
              }
              if (i === 3) burstPuffs(anim, 3); // 「掏出来」那一下的小爆点
            }, t)
          );
          t += s.ms;
        });
        timers.push(window.setTimeout(run, t));
      };
      run();
    }

    let lastT = performance.now();
    /* 进入本状态的时间基准：头顶道具的进场动画按「已进入多久」计时，而不是绝对时钟 */
    const fxT0 = lastT;
    const tick = (now: number) => {
      if (cancelled) return;
      const dt = Math.min(50, now - lastT);
      lastT = now;

      if (isThinking) {
        if (anim.wpDur > 0) {
          const k = Math.min(1, (now - anim.wpStart) / anim.wpDur);
          anim.wp = anim.wpFrom + (anim.wpTo - anim.wpFrom) * k;
          if (k >= 1) anim.wpDur = 0;
        }
        if (bookG && pencilG) drawBook(bookG, pencilG, anim.wp, now);
        if (anim.emitOn) {
          anim.emitAcc += dt;
          if (anim.emitAcc > 150) {
            anim.emitAcc = 0;
            spawnPuff(anim);
          }
        }
        updatePuffs(anim, dt);
        if (smokeG) drawPuffs(smokeG, anim);
      } else if (overlayG && spec.fx) {
        drawOverlay(overlayG, spec.fx, now - fxT0);
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      timers.forEach((id) => window.clearTimeout(id));
    };
  }, [shown, isThinking, spec.fx, reduced]);

  /* --- JSX 派生类名 --- */
  const seqItem = SEQ[effPhase] ?? SEQ[0];
  const petwrapClass = isThinking ? "boxcat-petwrap " + (seqItem.cls ?? "") : "boxcat-petwrap";
  const cellClass = isThinking ? "boxcat-cell" : "boxcat-cell boxcat-s-" + spec.body;
  const spriteClass = isThinking
    ? "boxcat-sprite boxcat-pk-" + seqItem.pet
    : "boxcat-sprite boxcat-a" + ROW_INDEX[spec.row];
  const bookClass =
    "boxcat-book" + (isThinking && seqItem.book ? " boxcat-book-" + seqItem.book : "");

  return (
    <div
      ref={boxRef}
      className="boxcat"
      role="img"
      aria-label={"Boxcat 桌宠，当前状态：" + spec.label}
      data-pet-state={pet_state}
    >
      <div className="boxcat-scale" style={{ transform: "scale(" + scale + ")" }}>
        <div className="boxcat-stage">
          <div className={petwrapClass}>
            <div className={cellClass}>
              {/* key 换体态即重挂载 → 进场动画重播，避免动作硬切「闪现」 */}
              <div key={spec.body} className="boxcat-sprwrap">
                <div className={spriteClass} />
                {!isThinking && spec.fx ? (
                  <canvas ref={overlayRef} className="boxcat-ov" width={CW} height={OV_H} />
                ) : null}
              </div>
            </div>
          </div>

          {isThinking ? (
            <>
              <div className={bookClass}>
                <canvas ref={bookRef} className="boxcat-bookcv" width={50} height={34} />
                <canvas ref={pencilRef} className="boxcat-pencil" width={58} height={42} />
              </div>
              <canvas ref={smokeRef} className="boxcat-fx" width={FW} height={FH} />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default Pet;
