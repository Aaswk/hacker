"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, api } from "@/lib/api";
import type { VisionEvent } from "@/types/contract";

import { CaptureError, captureFrame } from "./capture";

export interface FrameReport {
  ok: boolean;
  /** 本地时间，便于在页面上看往返节奏 */
  at: string;
  message: string;
}

export interface UseFrameReporterOptions {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** 摄像头就绪时才真正截帧，未就绪时空转等待 */
  cameraReady: boolean;
  /** 抽帧间隔，默认 500ms（约 2 FPS，对齐 C 的上限要求） */
  intervalMs?: number;
  /**
   * C 在 /frame 里回了新事件时回调。
   * 这是 C → A 的唯一即时信号，不含 pet_state / message；
   * 状态与文案仍由 useObservationFeed 轮询 B 得到。
   */
  onEvent?: (event: VisionEvent) => void;
}

export interface UseFrameReporterResult {
  active: boolean;
  start: () => void;
  stop: () => void;
  /** 成功送达 C 的拍数 */
  successCount: number;
  /** C 回了新事件的拍数 */
  eventCount: number;
  /** C 回 204（无新事件）的拍数 */
  noEventCount: number;
  failureCount: number;
  lastReport: FrameReport | null;
}

function pad2(value: number): string {
  return String(Math.floor(Math.abs(value))).padStart(2, "0");
}

/** 带时区的 ISO 8601（如 +08:00），对齐 0.3 协议对 timestamp 的要求 */
function isoWithOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const datePart = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  const timePart = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  return `${datePart}T${timePart}${sign}${pad2(offsetMinutes / 60)}:${pad2(offsetMinutes % 60)}`;
}

function timeLabel(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

/**
 * 上报链路：节流截帧 → 交给 C 的识别入口 → 处理往返结果。
 * C 的新事件交给 onEvent，A 不在这里提交 B 的 /events。
 * 异常分支（超时 / 请求失败 / 响应字段异常）只影响当前这一拍，循环继续。
 */
export function useFrameReporter({
  videoRef,
  cameraReady,
  intervalMs = 500,
  onEvent,
}: UseFrameReporterOptions): UseFrameReporterResult {
  const [active, setActive] = useState(false);
  const [successCount, setSuccessCount] = useState(0);
  const [eventCount, setEventCount] = useState(0);
  const [noEventCount, setNoEventCount] = useState(0);
  const [failureCount, setFailureCount] = useState(0);
  const [lastReport, setLastReport] = useState<FrameReport | null>(null);

  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  const reportOnce = useCallback(async () => {
    const timestamp = isoWithOffset(new Date());

    try {
      const frame = await captureFrame(videoRef.current);
      const result = await api.sendFrame(frame, { timestamp });

      // 完整往返都记在控制台，方便联调时核对字段
      console.info("[上报往返]", {
        bytes: frame.size,
        timestamp,
        kind: result.kind,
        response: result.raw,
      });

      setSuccessCount((count) => count + 1);

      // "none"：C 这一拍没有新事件（204 / 200 空体 / 200 无 event），不是错误
      if (result.kind === "none") {
        setNoEventCount((count) => count + 1);
        setLastReport({
          ok: true,
          at: timeLabel(),
          message: "C：这一拍无新事件",
        });
        return;
      }

      onEventRef.current?.(result.event);
      setEventCount((count) => count + 1);
      setLastReport({
        ok: true,
        at: timeLabel(),
        message: `C 检测到事件：${result.event.event}`,
      });
    } catch (err) {
      const message =
        err instanceof CaptureError || err instanceof ApiError
          ? err.message
          : "上报失败：未知错误";
      console.error("[上报往返] 失败：", err);
      setFailureCount((count) => count + 1);
      setLastReport({ ok: false, at: timeLabel(), message });
    }
  }, [videoRef]);

  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      if (cancelled) return;
      if (cameraReady) {
        await reportOnce();
      }
      if (!cancelled) {
        timer = setTimeout(() => void tick(), intervalMs);
      }
    };

    timer = setTimeout(() => void tick(), 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, cameraReady, intervalMs, reportOnce]);

  const start = useCallback(() => setActive(true), []);
  const stop = useCallback(() => setActive(false), []);

  return {
    active,
    start,
    stop,
    successCount,
    eventCount,
    noEventCount,
    failureCount,
    lastReport,
  };
}
