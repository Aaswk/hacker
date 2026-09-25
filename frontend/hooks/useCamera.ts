"use client";

import { useCallback, useEffect, useRef, useState, type RefCallback } from "react";

/**
 * 摄像头状态机。覆盖 Step 1 要求的分支：
 * loading / permission denied / camera unavailable，其余失败统一进 error
 * （Step 2 的截帧失败也复用 error）。
 */
export type CameraStatus =
  | "idle"
  | "loading"
  | "ready"
  | "denied"
  | "unavailable"
  | "error";

export interface UseCameraOptions {
  /** 进入页面即请求权限（文档要求：进入即请求、离开即释放） */
  autoStart?: boolean;
}

export interface UseCameraResult {
  status: CameraStatus;
  error: string | null;
  stream: MediaStream | null;
  /** 传给 <video ref={...}>，同时保留普通 ref，供 Step 2 截帧使用 */
  attachVideo: RefCallback<HTMLVideoElement | null>;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  start: () => Promise<void>;
  stop: () => void;
}

function mapCameraError(err: unknown): { status: CameraStatus; message: string } {
  const name = err instanceof DOMException ? err.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return {
        status: "denied",
        message: "摄像头权限被拒绝，请在浏览器地址栏的权限设置中允许摄像头后重试。",
      };
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return { status: "unavailable", message: "未找到可用的摄像头设备。" };
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return {
        status: "unavailable",
        message: "摄像头被其他程序占用，或被系统 / 浏览器策略阻止。",
      };
    default:
      return { status: "error", message: "摄像头启动失败，请重试。" };
  }
}

export function useCamera({ autoStart = true }: UseCameraOptions = {}): UseCameraResult {
  const [status, setStatus] = useState<CameraStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const startingRef = useRef(false);
  const disposedRef = useRef(false);

  /** 释放媒体资源：停掉所有 track，摄像头指示灯随之熄灭 */
  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const start = useCallback(async () => {
    // 已在运行或正在请求时，不重复触发（避免二次权限弹窗）
    if (startingRef.current || streamRef.current) return;

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setStatus("unavailable");
      setError("当前浏览器不支持摄像头，或页面不在 HTTPS / localhost 环境下。");
      return;
    }

    startingRef.current = true;
    setStatus("loading");
    setError(null);

    try {
      const next = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: "user",
        },
        audio: false,
      });

      // 请求返回前组件已卸载：立即释放，避免摄像头一直亮着
      if (disposedRef.current) {
        next.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = next;
      setStream(next);
      setStatus("ready");
    } catch (err) {
      if (disposedRef.current) return;
      streamRef.current = null;
      setStream(null);
      const mapped = mapCameraError(err);
      setStatus(mapped.status);
      setError(mapped.message);
    } finally {
      startingRef.current = false;
    }
  }, []);

  const stop = useCallback(() => {
    releaseStream();
    setStatus("idle");
    setError(null);
  }, [releaseStream]);

  /** 把流绑定到视频元素；预览隐藏时元素仍在，流不中断（Step 2 截帧依赖这一点） */
  const attachVideo = useCallback<RefCallback<HTMLVideoElement | null>>((el) => {
    videoRef.current = el;
    if (!el) return;
    el.srcObject = streamRef.current;
    if (streamRef.current) {
      void el.play().catch(() => {
        /* 自动播放被拦截时忽略，muted + autoPlay 已尽量规避 */
      });
    }
  }, []);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = stream;
    if (stream) {
      void el.play().catch(() => {
        /* 同上 */
      });
    }
  }, [stream]);

  /** 生命周期绑定：进入即请求、离开即释放 */
  useEffect(() => {
    disposedRef.current = false;
    // 延后一拍再请求，避免在 effect 内同步 setState 触发级联渲染
    const timer = autoStart ? setTimeout(() => void start(), 0) : undefined;

    return () => {
      if (timer !== undefined) clearTimeout(timer);
      disposedRef.current = true;
      startingRef.current = false;
      releaseStream();
    };
  }, [autoStart, start, releaseStream]);

  return { status, error, stream, attachVideo, videoRef, start, stop };
}
