#!/usr/bin/env node
/**
 * B 接口契约自检（口径来源：A 侧 lib/api.ts 的 isObservation + useObservationFeed 的轮询去重逻辑）
 *
 * 用法：
 *   node scripts/check-b-contract.mjs                 # 读接口，不写数据
 *   node scripts/check-b-contract.mjs --write         # 额外真实 POST /events（会往库里写一条测试记录）
 *   node scripts/check-b-contract.mjs http://localhost:8001
 *
 * 无第三方依赖，Node 20+ 直接运行。全部通过时退出码 0，有 FAIL 时退出码 1。
 */

const HUMAN_EVENTS = [
  "PERSON_ENTER",
  "DRINKING",
  "STRETCHING",
  "PERSON_LEFT",
  "PERSON_RETURNED",
  "UNKNOWN",
];

const PET_STATES = [
  "IDLE",
  "OBSERVING",
  "THINKING",
  "CURIOUS",
  "ALERT",
  "EXCITED",
  "CONFUSED",
];

/** A 前端的 Origin，CORS 必须放行它 */
const ORIGIN = "http://localhost:3000";

/** A 的查询类接口超时（api.ts: DEFAULT_TIMEOUT_MS） */
const TIMEOUT_MS = 5000;

/** A 的轮询间隔，单次响应慢于它就会堆积 */
const POLL_INTERVAL_MS = 2000;

const argv = process.argv.slice(2);
const writeMode = argv.includes("--write");
const BASE_URL = (argv.find((a) => !a.startsWith("--")) ?? "http://localhost:8001").replace(/\/+$/, "");

let passCount = 0;
let failCount = 0;
let warnCount = 0;

function pass(name, detail) {
  passCount += 1;
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name, detail) {
  failCount += 1;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

function warn(name, detail) {
  warnCount += 1;
  console.log(`  WARN  ${name}${detail ? ` — ${detail}` : ""}`);
}

function check(ok, name, detail) {
  if (ok) pass(name, detail);
  else fail(name, detail);
  return ok;
}

function section(title) {
  console.log(`\n${title}`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/** 与 A 侧 lib/api.ts 的 isObservation 保持一致 */
function isObservation(value) {
  if (!isRecord(value)) return false;
  return (
    typeof value.observation_id === "number" &&
    typeof value.event === "string" &&
    HUMAN_EVENTS.includes(value.event) &&
    typeof value.pet_state === "string" &&
    PET_STATES.includes(value.pet_state) &&
    typeof value.message === "string"
  );
}

/** 逐字段列出不符合契约的地方，便于 B 定位 */
function describeObservationIssues(value, label) {
  const issues = [];
  if (!isRecord(value)) return [`${label} 不是对象`];
  if (typeof value.observation_id !== "number") {
    issues.push(`observation_id 应为 number，实际 ${JSON.stringify(value.observation_id)}`);
  }
  if (typeof value.event !== "string" || !HUMAN_EVENTS.includes(value.event)) {
    issues.push(`event 不在 6 枚举内，实际 ${JSON.stringify(value.event)}`);
  }
  if (typeof value.pet_state !== "string" || !PET_STATES.includes(value.pet_state)) {
    issues.push(`pet_state 不在 7 枚举内，实际 ${JSON.stringify(value.pet_state)}`);
  }
  if (typeof value.message !== "string") {
    issues.push(`message 应为 string，实际 ${JSON.stringify(value.message)}`);
  }
  return issues;
}

async function http(path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(`${BASE_URL}${path}`, { ...init, signal: controller.signal });
    return { res, ms: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(res) {
  const text = await res.text();
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: undefined, text };
  }
}

async function main() {
  console.log(`B 接口契约自检 → ${BASE_URL}`);
  console.log(writeMode ? "模式：读写（会写一条测试数据）" : "模式：只读（加 --write 才会 POST /events）");

  // ---------- 1. GET /observations 连通性 ----------
  section("1. GET /observations 连通性");
  let observations;
  try {
    const { res, ms } = await http("/observations");
    if (!check(res.ok, "HTTP 200", `实际 ${res.status}`)) return finish();
    const { json, text } = await readJson(res);
    if (!check(json !== undefined, "响应是合法 JSON", text.slice(0, 120))) return finish();
    if (!check(Array.isArray(json), "响应是裸数组 Observation[]（不是 {items:[]}/{data:[]} 包装）",
      Array.isArray(json) ? `共 ${json.length} 条` : `实际是 ${JSON.stringify(json).slice(0, 120)}`)) return finish();
    observations = json;
    check(ms < TIMEOUT_MS, "响应未触发 A 的 5s 超时", `${ms}ms`);
    if (ms >= POLL_INTERVAL_MS) warn("响应慢于 A 的 2s 轮询间隔", `${ms}ms，会堆积`);
    else pass("响应快于 A 的轮询间隔", `${ms}ms`);
  } catch (err) {
    fail("请求可达", err instanceof Error ? err.message : String(err));
    console.log("        → 服务没起、或 CORS 预检没过（A 前端会表现为「网络错误：/observations」）");
    return finish();
  }

  // ---------- 2. 逐条字段校验 ----------
  section("2. 每条 Observation 的字段与枚举");
  if (observations.length === 0) {
    warn("列表为空", "字段校验跳过；建议先 POST /events 造一条再跑本脚本");
  } else {
    const bad = observations.filter((item) => !isObservation(item));
    check(bad.length === 0, "全部记录通过 A 的 isObservation 校验",
      bad.length === 0 ? `${observations.length} 条全部通过` : `${bad.length} 条会被 A 静默丢弃`);
    for (const item of bad.slice(0, 5)) {
      for (const issue of describeObservationIssues(item, "记录")) {
        fail("字段不符合契约（该条会被前端丢弃）", issue);
      }
    }

    const emptyMessage = observations.filter((item) => isRecord(item) && item.message === "");
    if (emptyMessage.length > 0) warn("message 为空字符串", `${emptyMessage.length} 条，前端气泡会是空的`);

    const usedEvents = [...new Set(observations.map((item) => (isRecord(item) ? item.event : undefined)))];
    const usedStates = [...new Set(observations.map((item) => (isRecord(item) ? item.pet_state : undefined)))];
    console.log(`        出现过的 event：${usedEvents.join(", ") || "—"}`);
    console.log(`        出现过的 pet_state：${usedStates.join(", ") || "—"}`);
  }

  // ---------- 3. observation_id 可去重性 ----------
  section("3. observation_id 必须严格递增、不重复（A 用它做本地去重）");
  const ids = observations.map((item) => (isRecord(item) ? item.observation_id : undefined));
  const numericIds = ids.filter((id) => typeof id === "number");
  check(numericIds.length === ids.length, "所有 observation_id 都是数字", `${numericIds.length}/${ids.length}`);
  check(
    numericIds.every((id) => Number.isInteger(id) && id > 0),
    "observation_id 是正整数",
  );
  const duplicateIds = numericIds.filter((id, index) => numericIds.indexOf(id) !== index);
  check(duplicateIds.length === 0, "无重复 id", duplicateIds.length === 0 ? "" : `重复：${[...new Set(duplicateIds)].join(", ")}`);
  if (numericIds.length > 1) {
    const maxId = Math.max(...numericIds);
    console.log(`        最大 observation_id = ${maxId}（A 会把它记为基线，之后只播 id > ${maxId} 的新记录）`);
  }

  // ---------- 4. CORS ----------
  section("4. CORS（A 跑在 http://localhost:3000）");
  try {
    const { res } = await http("/observations", {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    const allowOrigin = res.headers.get("access-control-allow-origin");
    check(res.ok, "OPTIONS 预检返回 2xx", `实际 ${res.status}`);
    check(
      allowOrigin === "*" || allowOrigin === ORIGIN,
      "预检放行 Origin",
      allowOrigin ? `access-control-allow-origin: ${allowOrigin}` : "响应缺少 access-control-allow-origin",
    );
  } catch (err) {
    fail("OPTIONS 预检可达", err instanceof Error ? err.message : String(err));
  }

  try {
    const { res } = await http("/observations", { headers: { Origin: ORIGIN } });
    const allowOrigin = res.headers.get("access-control-allow-origin");
    check(
      allowOrigin === "*" || allowOrigin === ORIGIN,
      "实际 GET 响应带 CORS 放行头",
      allowOrigin ? `access-control-allow-origin: ${allowOrigin}` : "响应缺少 access-control-allow-origin",
    );
  } catch (err) {
    fail("实际 GET 可达", err instanceof Error ? err.message : String(err));
  }

  // ---------- 5. 查询类接口形状 ----------
  section("5. GET /subjects/HUMAN_001");
  try {
    const { res } = await http("/subjects/HUMAN_001");
    if (check(res.ok, "HTTP 200", `实际 ${res.status}`)) {
      const { json } = await readJson(res);
      const hasCounts = isRecord(json) && isRecord(json.event_counts);
      if (check(hasCounts, "含 event_counts 对象", JSON.stringify(json).slice(0, 160))) {
        const keys = Object.keys(json.event_counts);
        const unknownKeys = keys.filter((key) => !HUMAN_EVENTS.includes(key));
        check(unknownKeys.length === 0, "event_counts 的 key 都是 6 枚举之一",
          unknownKeys.length === 0 ? `计数项：${keys.join(", ") || "—"}` : `非法 key：${unknownKeys.join(", ")}`);
      }
    }
  } catch (err) {
    fail("GET /subjects/HUMAN_001 可达", err instanceof Error ? err.message : String(err));
  }

  section("6. GET /species-card");
  try {
    const { res } = await http("/species-card");
    if (check(res.ok, "HTTP 200", `实际 ${res.status}`)) {
      const { json } = await readJson(res);
      // A 侧 SpeciesCard 目前是占位类型，这里只做存在性检查并打印真实形状
      console.log(`        实际返回形状：${JSON.stringify(json).slice(0, 300)}`);
      warn("字段名待三方定稿", "A 目前按 { subject_id, title, description, event_counts } 占位，请对照上面实际形状确认");
    }
  } catch (err) {
    fail("GET /species-card 可达", err instanceof Error ? err.message : String(err));
  }

  // ---------- 7. POST /events 写入 → 读出闭环 ----------
  section("7. POST /events 写入 → /observations 读出闭环");
  if (!writeMode) {
    warn("已跳过（只读模式）", "加 --write 可验证「C 提交 → A 能读到」，会往库里写一条 STRETCHING 测试记录");
  } else {
    const beforeMax = numericIds.length > 0 ? Math.max(...numericIds) : 0;
    const payload = {
      subject_id: "HUMAN_001",
      event: "STRETCHING",
      confidence: 0.88,
      timestamp: new Date().toISOString(),
    };
    try {
      const { res } = await http("/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify(payload),
      });
      if (!check(res.ok, "POST /events 返回 2xx", `实际 ${res.status}`)) {
        const { text } = await readJson(res);
        console.log(`        响应体：${text.slice(0, 200)}`);
      } else {
        const { json } = await readJson(res);
        const returnedObservation = isObservation(json);
        if (returnedObservation) pass("响应体是一条合法 Observation（A 的 Mock 依赖它）");
        else warn("响应体不是 Observation", `实际：${JSON.stringify(json).slice(0, 180)}；A 的 Mock 模式会抛错，但主链路不受影响`);

        // 回读
        const { json: after } = await readJson((await http("/observations")).res);
        const list = Array.isArray(after) ? after : [];
        const created = list.filter((item) => isRecord(item) && item.observation_id > beforeMax);
        check(created.length >= 1, "新记录已出现在 /observations 中",
          created.length >= 1 ? `新增 ${created.length} 条，最大 id = ${Math.max(...created.map((i) => i.observation_id))}` : "未读到新记录");
        const wrongEvent = created.filter((item) => item.event !== "STRETCHING");
        check(wrongEvent.length === 0, "新记录的 event 与提交值一致（STRETCHING）",
          wrongEvent.length === 0 ? "" : `实际：${wrongEvent.map((i) => i.event).join(", ")}`);
      }
    } catch (err) {
      fail("POST /events 可达", err instanceof Error ? err.message : String(err));
    }
  }

  // ---------- 8. 非法枚举的拒绝行为（仅提示） ----------
  section("8. 非法枚举应被拒绝（仅提示，不算失败）");
  if (!writeMode) {
    warn("已跳过", "加 --write 会顺带发一条 event=DRINK 的非法请求，期望 422");
  } else {
    try {
      const { res } = await http("/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject_id: "HUMAN_001", event: "DRINK", confidence: 0.5, timestamp: new Date().toISOString() }),
      });
      if (res.status === 422 || res.status === 400) pass("非法 event 被拒绝", `HTTP ${res.status}`);
      else warn("非法 event 未被拒绝", `HTTP ${res.status}；A 会把 DRINK 当成脏数据静默丢弃`);
    } catch (err) {
      warn("非法枚举检查未能完成", err instanceof Error ? err.message : String(err));
    }
  }

  finish();
}

function finish() {
  console.log("\n" + "─".repeat(56));
  console.log(`PASS ${passCount} / FAIL ${failCount} / WARN ${warnCount}`);
  if (failCount === 0) {
    console.log("结论：A 可以正常对接。");
  } else {
    console.log("结论：存在 FAIL 项，A 会丢弃这些数据或连不上，需先修。");
  }
  // 不用 process.exit()：Windows 上它会与 undici 的连接关闭竞态，触发 libuv 断言
  process.exitCode = failCount === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("自检脚本异常：", err);
  process.exitCode = 1;
});
