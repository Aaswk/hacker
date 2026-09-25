/**
 * 统一接口协议类型（契约源在 B 手上，本文件必须与 A 文档 0.3 节保持一致）
 * 字段一律 snake_case，不新增不自造枚举值。
 */

/** 桌宠状态：7 个，不新增不自造 */
export const PET_STATES = [
  "IDLE",
  "OBSERVING",
  "THINKING",
  "CURIOUS",
  "ALERT",
  "EXCITED",
  "CONFUSED",
] as const;

export type PetState = (typeof PET_STATES)[number];

/** 人类行为事件：6 个，不新增不自造 */
export const HUMAN_EVENTS = [
  "PERSON_ENTER",
  "DRINKING",
  "STRETCHING",
  "PERSON_LEFT",
  "PERSON_RETURNED",
  "UNKNOWN",
] as const;

export type HumanEventType = (typeof HUMAN_EVENTS)[number];

/** C → B：POST /events 请求体 */
export interface HumanEvent {
  subject_id: string;
  event: HumanEventType;
  /** 0 ~ 1 */
  confidence: number;
  /** 带时区的 ISO 8601，如 2026-09-25T21:08:32+08:00 */
  timestamp: string;
}

/** B → A：POST /events 响应（A 的直接输入） */
export interface Observation {
  observation_id: number;
  event: HumanEventType;
  pet_state: PetState;
  /** 只允许 message，不允许 alien_interpretation */
  message: string;
  /**
   * 以下三个字段不是 A 的必填输入：POST /events 的响应体里没有它们，
   * 只有 GET /observations 会额外下发（B 后端实测）。
   * 仅用于 Step 6 观察日志抽屉展示「时间」与「置信度条」，字段名与 B 保持一致。
   */
  subject_id?: string;
  /** 0 ~ 1 */
  confidence?: number;
  /** 带时区的 ISO 8601 */
  timestamp?: string;
}

/**
 * C → A：POST /frame 的响应体（C 检测到新事件时返回）。
 * C 无新事件时返回 204 空响应体，不带这个对象。
 * A 只用 event 字段；其余字段由 C 负责提交给 B，A 不参与 POST /events。
 */
export interface VisionEvent {
  event: HumanEventType;
  confidence?: number;
  timestamp?: string;
  subject_id?: string;
}

/**
 * 以下两个查询类接口的形状已按 B 后端实测响应定稿（2026-09-26 契约自检 PASS 20/FAIL 0）。
 * 卡片标题「HUMAN #001」由前端固定文案渲染，不在响应里下发。
 */

/** GET /subjects/HUMAN_001：累计行为计数 */
export interface SubjectSummary {
  subject_id: string;
  total_observations: number;
  event_counts: Partial<Record<HumanEventType, number>>;
}

/** GET /species-card：HUMAN #001 人类物种卡 */
export interface SpeciesCard {
  subject_id: string;
  /** 后端生成的物种描述文案，可能为空串 */
  summary: string;
  event_counts: Partial<Record<HumanEventType, number>>;
}
