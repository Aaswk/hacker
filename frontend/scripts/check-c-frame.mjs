#!/usr/bin/env node
/**
 * C 的契约自检：/frame（送帧识别）+ /cartoon（AnimeGANv2 动漫化）+ C → B 上报链路
 * 校验口径来自 A 侧 lib/api.ts 的 sendFrame / types/contract.ts 的 VisionEvent，
 * 以及 app/api/cartoon/route.ts 的 viaAnimegan。
 *
 * 用法：
 *   node scripts/check-c-frame.mjs                          # 连通性 + CORS + 入参校验（不需要图片）
 *   node scripts/check-c-frame.mjs --frame shot.jpg         # /frame 完整契约测试（需要一张真实 JPEG）
 *   node scripts/check-c-frame.mjs --portrait face.jpg      # /cartoon 动漫化测试（需要一张真实人像 JPEG）
 *   node scripts/check-c-frame.mjs http://localhost:8002 --frame shot.jpg --portrait face.jpg --b http://localhost:8001
 *
 * 无第三方依赖，Node 20+ 直接运行。全部通过时退出码 0，有 FAIL 时退出码 1。
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const HUMAN_EVENTS = [
  "PERSON_ENTER",
  "DRINKING",
  "STRETCHING",
  "PERSON_LEFT",
  "PERSON_RETURNED",
  "UNKNOWN",
];

/** A 前端的 Origin，C 必须放行它 */
const ORIGIN = "http://localhost:3000";

/** A 的 /frame 超时（api.ts: FRAME_TIMEOUT_MS） */
const FRAME_TIMEOUT_MS = 10000;

/** A 的 /cartoon 超时（route.ts: ANIMEGAN_TIMEOUT_MS） */
const CARTOON_TIMEOUT_MS = 8000;

/** 等 C 上报到 B 的最长时间 */
const B_WAIT_MS = 10000;

const argv = process.argv.slice(2);
let cUrlArg = null;
let framePath = null;
let portraitPath = null;
let bUrlArg = null;
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--frame") framePath = argv[++i];
  else if (arg === "--portrait") portraitPath = argv[++i];
  else if (arg === "--b") bUrlArg = argv[++i];
  else if (!arg.startsWith("--")) cUrlArg = arg;
}
const C_URL = (cUrlArg ?? "http://localhost:8002").replace(/\/+$/, "");
const B_URL = (bUrlArg ?? "http://localhost:8001").replace(/\/+$/, "");

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

function pad2(value) {
  return String(Math.floor(Math.abs(value))).padStart(2, "0");
}

/** 与 A 侧 useFrameReporter 的 isoWithOffset 完全一致 */
function isoWithOffset(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const datePart = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  const timePart = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  return `${datePart}T${timePart}${sign}${pad2(offsetMinutes / 60)}:${pad2(offsetMinutes % 60)}`;
}

/**
 * 用 A 服务端的真实方式请求动漫化：
 * multipart/form-data，字段 image（JPEG），不带 Origin（这是服务端到服务端，C 不需要为此开 CORS）。
 * 期望：200 + Content-Type: image/* + 图片二进制。
 */
async function postCartoon(portrait) {
  const form = new FormData();
  if (portrait) {
    form.append("image", new Blob([portrait.bytes], { type: "image/jpeg" }), portrait.name);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CARTOON_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(`${C_URL}/cartoon`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { res, buf, ms: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

/** 用 A 的真实方式发一拍：multipart/form-data，字段 frame + timestamp，不手动设 Content-Type */
async function postFrame(frame) {
  const form = new FormData();
  if (frame) {
    form.append("frame", new Blob([frame.bytes], { type: "image/jpeg" }), frame.name);
  }
  form.append("timestamp", isoWithOffset(new Date()));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FRAME_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(`${C_URL}/frame`, {
      method: "POST",
      body: form,
      headers: { Origin: ORIGIN },
      signal: controller.signal,
    });
    const text = await res.text();
    return { res, text, ms: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

/** 判定 C 的响应属于哪条分支，以及 A 会怎么处理 */
function evaluateResponse(status, text) {
  if (status === 204) {
    return { level: "pass", verdict: "204 空体 = 无新事件（A 的首选语义，直接支持）" };
  }
  if (status === 200) {
    const trimmed = text.trim();
    if (!trimmed) {
      return { level: "warn", verdict: "200 + 空体：A 会当「无新事件」，但 0.3 节建议用 204，请 C 定稿" };
    }
    let json;
    try {
      json = JSON.parse(trimmed);
    } catch {
      return { level: "warn", verdict: "200 + 非 JSON：A 会当「无新事件」并打一条 warn 日志" };
    }
    if (json !== null && typeof json === "object" && typeof json.event === "string" && HUMAN_EVENTS.includes(json.event)) {
      return { level: "pass", verdict: `200 + 合法事件 ${json.event}（有事件分支）` };
    }
    return { level: "warn", verdict: `200 + JSON 但无合法 event：A 当「无新事件」，实际 ${JSON.stringify(json).slice(0, 140)}` };
  }
  if (status >= 200 && status < 300) {
    return { level: "warn", verdict: `${status} 不是约定状态码，A 会当「无新事件」` };
  }
  return { level: "fail", verdict: `${status} 非 2xx，A 会记为「帧上报失败」` };
}

function reportCors(res, name) {
  const allowOrigin = res.headers.get("access-control-allow-origin");
  check(
    allowOrigin === "*" || allowOrigin === ORIGIN,
    name,
    allowOrigin ? `access-control-allow-origin: ${allowOrigin}` : "响应缺少 access-control-allow-origin（浏览器会把这一拍判为失败）",
  );
}

async function maxObservationId() {
  const res = await fetch(`${B_URL}/observations`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error("B 的 /observations 不是裸数组");
  const ids = list.map((item) => (item && typeof item.observation_id === "number" ? item.observation_id : null)).filter((id) => id !== null);
  return ids.length > 0 ? Math.max(...ids) : 0;
}

async function main() {
  console.log(`C 的契约自检 → ${C_URL}（/frame 送帧识别 + /cartoon 动漫化）`);
  console.log(`C → B 上报链路将检查 → ${B_URL}`);
  console.log("\nA 实际发出的请求长这样：");
  console.log(`  POST ${C_URL}/frame`);
  console.log("  Content-Type: multipart/form-data（浏览器自动带 boundary，A 不手动设置）");
  console.log("  frame     = image/jpeg，最长边 ≤ 1280、质量 0.7，约 2 FPS，文件名 frame-<毫秒>.jpg");
  console.log(`  timestamp = 带时区 ISO 8601，本轮示例 ${isoWithOffset(new Date())}`);
  console.log(`  POST ${C_URL}/cartoon`);
  console.log("  Content-Type: multipart/form-data（服务端发，无 Origin）");
  console.log("  image     = image/jpeg 人像，文件名 portrait.jpg；返回图片二进制");

  // ---------- 1. 端点存在性 + 入参校验 ----------
  section("1. 端点存在性（故意不发 frame 字段，应被拒绝）");
  let frameReachable = true;
  try {
    const { res, text, ms } = await postFrame(null);
    if (res.status >= 400) {
      pass("缺少 frame 字段时返回 4xx", `HTTP ${res.status}`);
    } else {
      warn("缺少 frame 字段也返回 2xx", `HTTP ${res.status}；C 没有校验必填字段`);
    }
    if (text.trim()) console.log(`        响应体：${text.trim().slice(0, 200)}`);
    check(ms < FRAME_TIMEOUT_MS, "响应未触发 A 的 10s 超时", `${ms}ms`);
    reportCors(res, "错误响应也带 CORS 头");
  } catch (err) {
    fail("POST /frame 可达", err instanceof Error ? err.message : String(err));
    console.log("        → C 没起、端口不对、或路径不是 /frame（A 前端会表现为「帧上报网络错误」）");
    frameReachable = false;
  }

  // ---------- 2. 完整契约 ----------
  section("2. 完整契约（真实 JPEG）");
  if (!frameReachable) {
    warn("已跳过", "/frame 不可达（见第 1 节），跳过第 2、3 节；/cartoon 仍会照常检查");
  } else if (!framePath) {
    warn("已跳过", "加 --frame <一张 jpg 的路径> 可跑完整契约；截一张图存成 jpg 即可");
    warn("响应语义未验证", "C 的 204/200 分支必须在真实帧上才能确认");
  } else {
    let frame;
    try {
      const bytes = await readFile(framePath);
      frame = { bytes, name: `frame-${Date.now()}.jpg` };
      pass("读取测试图片", `${basename(framePath)}，${bytes.length} 字节`);
    } catch (err) {
      fail("读取测试图片", err instanceof Error ? err.message : String(err));
      return finish();
    }

    // 先记 B 的基线，才能判断 C 有没有上报
    let beforeId = null;
    try {
      beforeId = await maxObservationId();
    } catch {
      warn("读 B 的 /observations 失败", "跳过 C → B 链路检查，只验 /frame 本身");
    }

    try {
      const { res, text, ms } = await postFrame(frame);
      const { level, verdict } = evaluateResponse(res.status, text);
      if (level === "pass") pass("响应语义符合 A 的预期", verdict);
      else if (level === "warn") warn("响应语义与 0.3 节不完全一致（A 仍能兼容）", verdict);
      else fail("响应语义不符合预期", verdict);

      if (text.trim()) console.log(`        响应体：${text.trim().slice(0, 300)}`);
      check(ms < FRAME_TIMEOUT_MS, "单拍耗时未触发 A 的 10s 超时", `${ms}ms`);
      reportCors(res, "实际 /frame 响应带 CORS 头");
    } catch (err) {
      fail("POST /frame（带真实帧）可达", err instanceof Error ? err.message : String(err));
    }

    // ---------- 3. C → B 链路 ----------
    section("3. C → B 上报链路（C 应自己 POST 到 B 的 /events）");
    if (beforeId === null) {
      warn("已跳过", "上一步没读到 B 的基线");
    } else {
      console.log(`        B 当前最大 observation_id = ${beforeId}`);
      const deadline = Date.now() + B_WAIT_MS;
      let found = null;
      while (Date.now() < deadline && found === null) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
          const latest = await maxObservationId();
          if (latest > beforeId) found = latest;
        } catch {
          // B 不可达时继续等，最后由下方 WARN 说明
        }
      }
      if (found !== null) {
        pass("C 已把事件写入 B", `新的 observation_id = ${found}`);
        console.log("        注：这证明「C 识别 → C 提交 /events → B 落库 → A 可读」整条链路成立");
      } else {
        warn(`等待 ${B_WAIT_MS / 1000}s 内 B 没有新增记录`,
          "两种可能：这一帧确实没识别到事件（正常），或 C 没有上报到 B；请对镜头做一次明确动作再跑一次");
      }
    }
  }

  // ---------- 4. /cartoon：AnimeGANv2 动漫化 ----------
  section("4. /cartoon 动漫化（A 服务端调用，非浏览器直连，不需要 CORS）");
  console.log(`        A 会这样调：POST ${C_URL}/cartoon`);
  console.log("        Content-Type: multipart/form-data；字段 image = image/jpeg（单次 8s 超时）");
  console.log("        期望：200 + Content-Type: image/* + 图片二进制（512×512）；失败则 A 保留抓拍原图");
  if (!portraitPath) {
    warn("已跳过", "加 --portrait <一张人像 jpg 的路径> 可跑本节");
  } else {
    let portrait;
    try {
      const bytes = await readFile(portraitPath);
      portrait = { bytes, name: `portrait-${Date.now()}.jpg` };
      pass("读取测试人像", `${basename(portraitPath)}，${bytes.length} 字节`);
    } catch (err) {
      fail("读取测试人像", err instanceof Error ? err.message : String(err));
      return finish();
    }

    // 4a. 端点存在性：故意不发 image 字段，应被拒绝
    try {
      const { res } = await postCartoon(null);
      if (res.status >= 400) pass("/cartoon 缺少 image 字段时返回 4xx", `HTTP ${res.status}`);
      else warn("/cartoon 缺少 image 字段也返回 2xx", `HTTP ${res.status}；C 没有校验必填字段`);
    } catch (err) {
      fail("POST /cartoon 可达", err instanceof Error ? err.message : String(err));
      console.log("        → C 没起、端口不对、或路径不是 /cartoon（A 会保留抓拍原图，不空卡）");
    }

    // 4b. 完整契约
    try {
      const { res, buf, ms } = await postCartoon(portrait);
      const contentType = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      check(res.status === 200, "/cartoon 返回 200", `HTTP ${res.status}`);
      check(contentType.startsWith("image/"), "/cartoon 返回图片 Content-Type", contentType || "（缺失）");
      check(buf.length > 0, "/cartoon 响应体非空", `${buf.length} 字节`);
      check(ms < CARTOON_TIMEOUT_MS, "耗时未触发 A 的 8s 超时", `${ms}ms`);
      if (!contentType.startsWith("image/")) {
        console.log(`        响应体（前 200 字节）：${buf.toString("utf8", 0, 200)}`);
      }
      if (res.status === 200 && contentType.startsWith("image/") && buf.length > 0) {
        console.log(`        → 动漫化结果 ${buf.length} 字节，A 会原样转 base64 交给物种卡`);
      }
    } catch (err) {
      fail("POST /cartoon（带真实人像）可达", err instanceof Error ? err.message : String(err));
    }
  }

  finish();
}

function finish() {
  console.log("\n" + "─".repeat(56));
  console.log(`PASS ${passCount} / FAIL ${failCount} / WARN ${warnCount}`);
  if (failCount === 0) {
    console.log("结论：A 可以正常向 C 送帧；/cartoon 动漫化这条路也通（未跑则见上方 WARN）。");
  } else {
    console.log("结论：存在 FAIL 项，A 的 /frame 送帧或 /cartoon 动漫化会失败，需先修。");
  }
  // 不用 process.exit()：Windows 上它会与 undici 的连接关闭竞态，触发 libuv 断言
  process.exitCode = failCount === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("自检脚本异常：", err);
  process.exitCode = 1;
});
