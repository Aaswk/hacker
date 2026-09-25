"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api, isObservation } from "@/lib/api";
import type { Observation } from "@/types/contract";

export interface UseObservationFeedOptions {
  /** 只在"开始观察"后轮询，避免无人观察时白跑 */
  enabled: boolean;
  /** 轮询间隔，默认 2000ms（对齐 B 段约定） */
  intervalMs?: number;
  /**
   * 仅对"本地未见过的 observation_id"触发（按 id 升序）。
   * 首轮成功加载只建立基线、不回调，避免把历史观察当新事件重放。
   */
  onObservation?: (observation: Observation) => void;
}

export interface UseObservationFeedResult {
  /** B 返回的全量列表，供日志抽屉使用 */
  observations: Observation[];
  /** 列表中最新的一条（observation_id 最大者） */
  lastObservation: Observation | null;
  /** 已处理的最大 observation_id，联调时可对照"是否重复播放" */
  maxObservationId: number;
  error: string | null;
}

/**
 * B → A 的观察日志同步：轮询 GET /observations。
 * 当前 B 的实现没有分页 / since_id 参数（见 B 的 OpenAPI），
 * 因此这里拉全量、在本地按 observation_id 去重，接口加增量参数后只改这一个文件。
 */
export function useObservationFeed({
  enabled,
  intervalMs = 2000,
  onObservation,
}: UseObservationFeedOptions): UseObservationFeedResult {
  const [observations, setObservations] = useState<Observation[]>([]);
  const [maxObservationId, setMaxObservationId] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const onObservationRef = useRef(onObservation);
  useEffect(() => {
    onObservationRef.current = onObservation;
  }, [onObservation]);

  /** 已处理的最大 id 放 ref，避免轮询闭包读到旧值 */
  const maxIdRef = useRef(0);
  /** 是否已建立基线；首轮只播种不回调 */
  const seededRef = useRef(false);

  const pollOnce = useCallback(async () => {
    try {
      const raw = await api.getObservations();
      // 契约外的脏数据不静默兜底，直接过滤掉
      const list = (Array.isArray(raw) ? raw : []).filter(isObservation);

      setObservations(list);
      setError(null);

      if (list.length === 0) {
        seededRef.current = true;
        return;
      }

      const latestId = Math.max(...list.map((item) => item.observation_id));

      if (!seededRef.current) {
        // 首轮：只记录基线，避免把页面打开前的历史观察重放成动画
        seededRef.current = true;
        maxIdRef.current = latestId;
        setMaxObservationId(latestId);
        return;
      }

      if (latestId <= maxIdRef.current) return;

      // 只回调真正新增的部分，按 id 升序，同一 id 不会重复播放
      const fresh = list
        .filter((item) => item.observation_id > maxIdRef.current)
        .sort((a, b) => a.observation_id - b.observation_id);

      maxIdRef.current = latestId;
      setMaxObservationId(latestId);
      for (const item of fresh) {
        onObservationRef.current?.(item);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "观察日志同步失败");
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      if (cancelled) return;
      await pollOnce();
      if (!cancelled) {
        timer = setTimeout(() => void tick(), intervalMs);
      }
    };

    timer = setTimeout(() => void tick(), 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, intervalMs, pollOnce]);

  return {
    observations,
    lastObservation: observations[observations.length - 1] ?? null,
    maxObservationId,
    error,
  };
}
