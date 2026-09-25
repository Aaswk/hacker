"use client";

import type { CameraStatus } from "@/hooks/useCamera";

interface CameraPermissionGuideProps {
  status: CameraStatus;
  message: string | null;
  onRetry: () => void;
}

/** 非法 / 异常状态的明确引导，保证拒绝权限时页面不崩且有下一步动作 */
export function CameraPermissionGuide({
  status,
  message,
  onRetry,
}: CameraPermissionGuideProps) {
  if (status === "loading") {
    return (
      <div className="flex aspect-video w-full items-center justify-center rounded-2xl border border-dashed border-zinc-600 text-sm text-zinc-400">
        正在请求摄像头权限…
      </div>
    );
  }

  return (
    <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-zinc-600 px-6 text-center">
      <p className="text-sm text-zinc-300">{message ?? "摄像头尚未开启。"}</p>

      {status === "denied" && (
        <ol className="list-decimal space-y-1 text-left text-xs text-zinc-500">
          <li>点击地址栏左侧的锁 / 摄像头图标</li>
          <li>把「摄像头」改为「允许」</li>
          <li>刷新页面，或点下方按钮重试</li>
        </ol>
      )}

      {status === "unavailable" && (
        <p className="text-xs text-zinc-500">
          请确认摄像头已连接、未被其他程序占用，且页面运行在 localhost 或 HTTPS 下。
        </p>
      )}

      {status !== "idle" && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background transition-opacity hover:opacity-80"
        >
          重试
        </button>
      )}
    </div>
  );
}
