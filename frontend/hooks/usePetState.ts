"use client";

import { useCallback, useRef, useState } from "react";

import type { BubbleTone } from "@/components/ObservationBubble/ObservationBubble";
import { useObservationFeed } from "@/hooks/useObservationFeed";
import { usePetBehavior } from "@/hooks/usePetBehavior";
import type { Observation, PetState } from "@/types/contract";

/* ==================================================================
   状态映射层（Step 5 · 核心枢纽）
   ------------------------------------------------------------------
   把 B 的 Observation 翻译成桌宠的完整表演，一次性触发三件事：

     Observation
        ↓
     ① 切入对应 pet_state，播放动画   （喂给行为引擎的队首状态覆盖）
     ② 弹出观察气泡                   （message 原文，配色由 pet_state 决定语气）
     ③ 追加一条 Observation 到日志     （会话内增量，按 observation_id 去重升序）

   并发与优先级：
   - 同一 observation_id 只消费一次（轮询 + 直连两条链路都会汇到这里）
   - ALERT 优先级最高，插队到队首，且不被普通观察打断（由行为引擎保证）
   - 气泡演完自动出队 → 状态自动回落，队列空后回到 OBSERVING 待机兜底
   ------------------------------------------------------------------
   数据来源（A 文档 0.3）：B → A 的 GET /observations（轮询，端口 8001）。
   ================================================================== */

/** pet_state → 气泡语气：只有警戒 / 发现换配色，其余都是「观察记录」 */
const STATE_TONE: Record<PetState, BubbleTone> = {
  IDLE: "normal",
  OBSERVING: "normal",
  THINKING: "normal",
  CURIOUS: "normal",
  CONFUSED: "normal",
  ALERT: "alert",
  EXCITED: "discover",
};

export interface UsePetStateOptions {
  /** 是否开始轮询 B 的 GET /observations；默认 false（Step 9 才由「开始观察」打开） */
  enabled?: boolean;
  /** 轮询间隔，默认 2000ms（对齐 B 段约定） */
  intervalMs?: number;
}

export function usePetState({
  enabled = false,
  intervalMs = 2000,
}: UsePetStateOptions = {}) {
  const behavior = usePetBehavior();
  const { push } = behavior;

  /** ③ 日志（会话内新增的 Observation，供 Step 6 的 LogDrawer 使用） */
  const [log, setLog] = useState<Observation[]>([]);
  /** 已消费过的 observation_id，避免两条链路重复播放 */
  const seenRef = useRef<Set<number>>(new Set());

  /** 一次收到 Observation → 状态 / 气泡 / 日志 三处同时发生 */
  const handleObservation = useCallback(
    (observation: Observation) => {
      if (seenRef.current.has(observation.observation_id)) return;
      seenRef.current.add(observation.observation_id);

      setLog((prev) =>
        prev.some((it) => it.observation_id === observation.observation_id)
          ? prev
          : [...prev, observation].sort(
            (a, b) => a.observation_id - b.observation_id,
          ),
      );

      // 动作由 B 的 pet_state 直接决定，气泡配色由它映射出的语气决定；
      // source = "observation"：B 的真实观察永不因队列满被丢弃
      push(
        STATE_TONE[observation.pet_state],
        observation.message,
        observation.pet_state,
        "observation",
      );
    },
    [push],
  );

  /** B → A：轮询 /observations，新记录逐条送进 handleObservation */
  const feed = useObservationFeed({
    enabled,
    intervalMs,
    onObservation: handleObservation,
  });

  return {
    ...behavior,
    /** 会话内追加的观察记录（③） */
    log,
    /** 手动喂一条 Observation（Step 2 直连响应 / Step 9 Mock 用） */
    handleObservation,
    /** B 的全量观察列表，供日志抽屉渲染 */
    observations: feed.observations,
    /** 最新一条（按 observation_id 最大者取，B 的接口是 id 倒序返回） */
    lastObservation: feed.lastObservation,
    /** 已处理到的最大 observation_id，联调时对照「是否重复播放」 */
    maxObservationId: feed.maxObservationId,
    /** 轮询失败信息（B 没起 / CORS 没过时会看到） */
    pollError: feed.error,
  };
}
