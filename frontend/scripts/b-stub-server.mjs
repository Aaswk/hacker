// B 段 FastAPI（hacker/app.py）的 Node 桩服务。
//
// 用途：本机没有 Python，无法 `uvicorn app:app` 启动 B 的真实服务；
// 这个桩逐字段复刻 app.py 的响应形状，供 A 侧联调 /live 页（轮询 8001）。
// 契约以 app.py 为准，B 侧真机启动后应停掉本桩、直接用真服务。
//
//   node scripts/b-stub-server.mjs        # 监听 http://localhost:8001
//
// 复刻的端点（与 app.py 一致）：
//   GET  /health
//   POST /events           201 -> { observation_id, event, pet_state, message }
//   GET  /observations     list，ORDER BY id DESC（新的在前）
//   GET  /subjects/HUMAN_001 -> { subject_id, total_observations, event_counts }
//   GET  /species-card     -> { subject_id, event_counts, summary }

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8001);
const ALLOW_ORIGINS = new Set(["http://localhost:3000", "http://127.0.0.1:3000"]);

/* 与 app.py 的 NARRATIVE 完全一致：event -> [pet_state, message] */
const NARRATIVE = {
  PERSON_ENTER: ["EXCITED", "检测到未知碳基生命体。开始建立观察档案。"],
  DRINKING: ["CURIOUS", "目标正在为内部海洋补充液体。"],
  STRETCHING: ["ALERT", "目标正在扩大身体面积，原因有待观察。"],
  PERSON_LEFT: ["ALERT", "观察对象离开了视野。"],
  PERSON_RETURNED: ["EXCITED", "观测体 №001 再次出现。"],
  UNKNOWN: ["CONFUSED", "记录到尚未理解的行为。"],
};

/* app.py 用 sqlite 自增主键；等价物就是内存里的自增 id */
let nextId = 1;
const rows = [];

export function reset() {
  nextId = 1;
  rows.length = 0;
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOW_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function counts(subjectId) {
  const out = {};
  for (const row of rows) {
    if (row.subject_id !== subjectId) continue;
    out[row.event] = (out[row.event] ?? 0) + 1;
  }
  return out;
}

const server = createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === "GET" && path === "/health") {
    return json(res, 200, { status: "ok" });
  }

  if (req.method === "POST" && path === "/events") {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return json(res, 422, { detail: "invalid JSON body" });
    }

    // 与 app.py 的校验对齐：只支持 HUMAN_001、confidence ∈ [0,1]、timestamp 带时区
    const { subject_id, event, confidence, timestamp } = payload ?? {};
    if (subject_id !== "HUMAN_001") {
      return json(res, 422, { detail: "MVP only supports HUMAN_001" });
    }
    if (!NARRATIVE[event]) {
      return json(res, 422, { detail: `unknown event: ${event}` });
    }
    if (typeof confidence !== "number" || Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
      return json(res, 422, { detail: "confidence must be within [0, 1]" });
    }
    if (typeof timestamp !== "string" || !/(Z|[+-]\d{2}:?\d{2})$/.test(timestamp)) {
      return json(res, 422, { detail: "timestamp must include a timezone" });
    }

    const [pet_state, message] = NARRATIVE[event];
    const row = {
      observation_id: nextId++,
      subject_id,
      event,
      confidence,
      timestamp,
      pet_state,
      message,
    };
    rows.push(row);

    // POST 的响应体不含 subject_id/confidence/timestamp（对齐 EventResponse）
    return json(res, 201, {
      observation_id: row.observation_id,
      event: row.event,
      pet_state: row.pet_state,
      message: row.message,
    });
  }

  if (req.method === "GET" && path === "/observations") {
    // ORDER BY id DESC：新的在前
    const list = [...rows].sort((a, b) => b.observation_id - a.observation_id);
    return json(res, 200, list);
  }

  const subjectMatch = path.match(/^\/subjects\/([^/]+)$/);
  if (req.method === "GET" && subjectMatch) {
    const subjectId = decodeURIComponent(subjectMatch[1]);
    if (subjectId !== "HUMAN_001") {
      return json(res, 404, { detail: "Unknown subject" });
    }
    const event_counts = counts(subjectId);
    return json(res, 200, {
      subject_id: subjectId,
      total_observations: Object.values(event_counts).reduce((a, b) => a + b, 0),
      event_counts,
    });
  }

  if (req.method === "GET" && path === "/species-card") {
    const event_counts = counts("HUMAN_001");
    const total = Object.values(event_counts).reduce((a, b) => a + b, 0);
    return json(res, 200, {
      subject_id: "HUMAN_001",
      event_counts,
      summary: total ? `已记录 ${total} 次观察。该生物持续表现出值得研究的日常行为。` : "",
    });
  }

  return json(res, 404, { detail: "Not Found" });
});

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("b-stub-server.mjs")) {
  server.listen(PORT, () => {
    console.log(`[B stub] http://localhost:${PORT}  (mirrors hacker/app.py)`);
  });
}
