/**
 * API 层：统一请求出口，所有网络请求都走这里，不散落在组件里。
 * 端口见 A 文档 0.3 节：A 前端 3000 / B 后端 FastAPI 8001 / C 视觉识别 8002。
 * 两个地址都可用 .env.local 覆盖；NEXT_PUBLIC_* 在编译期内联，改完必须重启 dev。
 */
import {
  HUMAN_EVENTS,
  PET_STATES,
  type HumanEvent,
  type Observation,
  type SpeciesCard,
  type SubjectSummary,
  type VisionEvent,
} from "@/types/contract";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8001";

/** C 的识别入口（A 只送画面，不做识别）。请求/响应格式见 0.3 节 ① */
const VISION_BASE_URL =
  process.env.NEXT_PUBLIC_VISION_URL ?? "http://localhost:8002";

const DEFAULT_TIMEOUT_MS = 5000;

/** 截帧 + 上传 + 识别，比查询类接口宽松 */
const FRAME_TIMEOUT_MS = 10000;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...init.headers,
      },
    });

    if (!res.ok) {
      throw new ApiError(`请求失败：${path}`, res.status);
    }

    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new ApiError(`请求超时：${path}`);
    }
    throw new ApiError(`网络错误：${path}`);
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 校验 B → A 的响应字段，字段不符时直接暴露，不静默兜底 */
export function isObservation(value: unknown): value is Observation {
  if (!isRecord(value)) return false;
  return (
    typeof value.observation_id === "number" &&
    typeof value.event === "string" &&
    (HUMAN_EVENTS as readonly string[]).includes(value.event) &&
    typeof value.pet_state === "string" &&
    (PET_STATES as readonly string[]).includes(value.pet_state) &&
    typeof value.message === "string"
  );
}

/**
 * 校验 C → A 的 /frame 响应：C 只在"检测到新事件"时回 200 + Event JSON。
 * 这里只强校验 event 枚举，其余字段可选（是否带 subject_id 由 C 决定）。
 */
export function isVisionEvent(value: unknown): value is VisionEvent {
  if (!isRecord(value)) return false;
  return (
    typeof value.event === "string" &&
    (HUMAN_EVENTS as readonly string[]).includes(value.event)
  );
}

/**
 * A → C 的一拍结果。
 * "none" 涵盖 C 的所有"没有新事件"表达：204 空体、200 空体、200 无 event 字段。
 * B 的联调建议：C 确认前不要把 200+空体判成协议错误，所以这里不设错误分支。
 */
export type FrameResult =
  | { kind: "event"; event: VisionEvent; raw: unknown }
  | { kind: "none"; raw: unknown };

export const api = {
  /**
   * 把一帧画面交给 C 的识别入口（A 不做识别）。
   * 契约：multipart/form-data，字段 frame（JPEG）+ timestamp（带时区 ISO 8601）。
   * C 有新事件 → 200 + VisionEvent；无新事件 → 204 空体（或 C 尚未定稿时的 200 空体）。
   * 注意：C 的响应不是 Observation，A 不在这里做任何状态映射。
   */
  async sendFrame(
    frame: Blob,
    meta: { timestamp: string },
    timeoutMs: number = FRAME_TIMEOUT_MS,
  ): Promise<FrameResult> {
    const form = new FormData();
    // 不手动设置 Content-Type，交给浏览器带上 multipart boundary
    form.append("frame", frame, `frame-${Date.now()}.jpg`);
    form.append("timestamp", meta.timestamp);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${VISION_BASE_URL}/frame`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });

      // 204 = 这一拍没有新事件，属正常分支，不是错误
      if (res.status === 204) {
        return { kind: "none", raw: null };
      }

      if (!res.ok) {
        throw new ApiError(`帧上报失败：HTTP ${res.status}`, res.status);
      }

      // 200 也可能是"没有新事件"，甚至体为空；读到文本再决定，避免无体时抛错
      const text = await res.text();
      if (!text.trim()) {
        return { kind: "none", raw: null };
      }

      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        console.warn(
          "[sendFrame] C 的 200 响应不是 JSON，按无事件处理：",
          text.slice(0, 200),
        );
        return { kind: "none", raw: text };
      }

      if (!isVisionEvent(raw)) {
        console.warn("[sendFrame] C 的 200 响应无 event 枚举，按无事件处理：", raw);
        return { kind: "none", raw };
      }
      return { kind: "event", event: raw, raw };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new ApiError("帧上报超时");
      }
      throw new ApiError("帧上报网络错误");
    } finally {
      clearTimeout(timer);
    }
  },

  /** 提交人类行为事件。正式链路里由 C 调用，A 侧仅用于 Mock / 演示手动触发 */
  async postEvent(payload: HumanEvent): Promise<Observation> {
    const data = await request<unknown>("/events", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (!isObservation(data)) {
      throw new ApiError("POST /events 响应字段不符合契约");
    }
    return data;
  },

  /** 观察日志抽屉的数据来源 */
  getObservations(): Promise<Observation[]> {
    return request<Observation[]>("/observations");
  },

  /** 累计行为计数（DRINKING × 4 等） */
  getSubject(subjectId: string): Promise<SubjectSummary> {
    return request<SubjectSummary>(`/subjects/${subjectId}`);
  },

  /** 《HUMAN #001 人类物种卡》 */
  getSpeciesCard(): Promise<SpeciesCard> {
    return request<SpeciesCard>("/species-card");
  },
};
