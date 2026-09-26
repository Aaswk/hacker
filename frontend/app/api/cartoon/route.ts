/**
 * 物种卡档案照 · 动漫化服务端代理（单引擎 + 原图兜底）
 * ------------------------------------------------------------------
 * 引擎：AnimeGANv2（C 的 8002 本地托管）。
 *   成功 → 返回动漫图；失败 → 返回 ok:false，由前端保留抓拍原图。
 *   现场演示最怕空卡，所以「失败」永远是可预期的正常返回（HTTP 200），
 *   由前端决定兜底展示，不把可预期的失败当服务器错误。
 *
 * 为什么不再用腾讯云 FaceCartoonPic 兜底：其动漫化风格偏差大、现场观感差，
 *   与其出一张「丑图」，不如直接保留真实抓拍照片。故已移除该引擎及其
 *   TC3-HMAC-SHA256 签名逻辑与 TENCENT_* 环境变量。
 *
 * 为什么 AnimeGANv2 不自建：公共 HF Space（akhaliq/AnimeGANv2）跑在 ZeroGPU 上，
 *   匿名配额约 180s/天 ≈ 3 次调用，现场演示必挂（实测：前 3 次成功，之后持续 error）。
 *   故改由 C 的视觉服务（8002）用 CPU 托管同一模型，免费且不限次。
 *   契约见《A交付C说明.md》第 9 节：POST /cartoon（multipart 入、图片二进制出）。
 *
 * 为什么走服务端代理：C 的地址与降级编排不适合暴露给浏览器。
 *
 * 请求：{ image: string, mime?: string }   image 为纯 base64（容忍 data URI 前缀），≤5M
 * 响应：{ ok: true, image: string, mime: string, engine: "animegan2" }
 *       { ok: false, reason, message }    引擎失败，前端保留原图
 * ------------------------------------------------------------------
 */
import { NextResponse } from "next/server";

/* ---------- C 的视觉服务地址（与 lib/api.ts 同一环境变量） ---------- */
const VISION_BASE_URL =
  process.env.NEXT_PUBLIC_VISION_URL ?? "http://localhost:8002";

/** base64 编码后上限 5M */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** AnimeGANv2 预算：C 侧 CPU 推理 512×512 约 1~3s，留足余量 */
const ANIMEGAN_TIMEOUT_MS = 8_000;

/** 容忍 data URI 前缀：兼容前端直接把 data URL 整串塞进来的情况 */
function stripDataUrlPrefix(image: string): string {
  return image.startsWith("data:") ? image.slice(image.indexOf(",") + 1) : image;
}

type EngineResult =
  | { ok: true; image: string; mime: string }
  | { ok: false; reason: string; message: string };

/* ================================================================== */
/* 引擎：AnimeGANv2（C 的视觉服务 8002 托管）                            */
/* 契约：POST /cartoon，multipart 字段 image（JPEG）→ 200 + 图片二进制   */
/* ================================================================== */
async function viaAnimegan(image: string, mime: string): Promise<EngineResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANIMEGAN_TIMEOUT_MS);
  try {
    const bytes = Buffer.from(image, "base64");
    const form = new FormData();
    form.append("image", new Blob([bytes], { type: mime }), "portrait.jpg");

    const res = await fetch(`${VISION_BASE_URL}/cartoon`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[cartoon] C 的 /cartoon 返回 HTTP ${res.status}，保留抓拍原图`);
      return { ok: false, reason: "animegan-error", message: `C 的 /cartoon HTTP ${res.status}` };
    }

    const outMime = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/webp";
    if (!outMime.startsWith("image/")) {
      console.warn(`[cartoon] C 的 /cartoon 未返回图片，Content-Type=${outMime}，保留抓拍原图`);
      return { ok: false, reason: "animegan-error", message: "C 的 /cartoon 响应不是图片" };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) {
      return { ok: false, reason: "animegan-error", message: "C 的 /cartoon 返回空图" };
    }
    return { ok: true, image: buf.toString("base64"), mime: outMime };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    console.warn("[cartoon] AnimeGANv2(8002) 失败，保留抓拍原图：", aborted ? "timeout" : err);
    return {
      ok: false,
      reason: aborted ? "animegan-timeout" : "animegan-error",
      message: aborted ? `AnimeGANv2 超时（${ANIMEGAN_TIMEOUT_MS / 1000}s）` : "AnimeGANv2 调用失败",
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ================================================================== */

export async function POST(request: Request) {
  let image = "";
  let mime = "image/jpeg";
  try {
    const body = (await request.json()) as { image?: unknown; mime?: unknown };
    if (typeof body.image === "string") image = stripDataUrlPrefix(body.image);
    if (typeof body.mime === "string" && body.mime.startsWith("image/")) mime = body.mime;
  } catch {
    /* body 解析失败走下面的参数缺失分支 */
  }
  if (!image) {
    return NextResponse.json({ ok: false, reason: "no-image", message: "缺少 image（base64）" });
  }
  if (image.length > MAX_IMAGE_BYTES) {
    return NextResponse.json({
      ok: false,
      reason: "image-too-large",
      message: "图片超过 5M 上限",
    });
  }

  const result = await viaAnimegan(image, mime);
  if (result.ok) {
    return NextResponse.json({
      ok: true,
      image: result.image,
      mime: result.mime,
      engine: "animegan2",
    });
  }

  // 失败不空卡：前端会用抓拍原图兜底，这里如实返回失败原因
  return NextResponse.json({
    ok: false,
    reason: result.reason,
    message: result.message,
  });
}
