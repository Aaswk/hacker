"use client";

import { useState } from "react";

import { useCamera } from "@/hooks/useCamera";

import { CameraPermissionGuide } from "./CameraPermissionGuide";
import { CameraPreview } from "./CameraPreview";

/** Step 1 的验收入口：开关摄像头、显示/隐藏预览、异常引导 */
export function CameraPanel() {
  const { status, error, attachVideo, start, stop } = useCamera();
  const [previewVisible, setPreviewVisible] = useState(true);

  return (
    <section className="w-full max-w-xl rounded-3xl border border-zinc-800 bg-zinc-950 p-6 text-zinc-100">
      <header className="mb-4 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">摄像头 · 观察窗口</h2>
          <p className="text-xs text-zinc-500">A 只负责送画面，不做任何识别</p>
        </div>
        <span className="shrink-0 rounded-full border border-zinc-700 px-3 py-1 font-mono text-xs text-zinc-400">
          {status}
        </span>
      </header>

      {status === "ready" ? (
        <>
          <CameraPreview attachVideo={attachVideo} visible={previewVisible} />
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => setPreviewVisible((visible) => !visible)}
              className="rounded-full border border-zinc-700 px-5 py-2 text-sm transition-colors hover:bg-zinc-900"
            >
              {previewVisible ? "隐藏预览" : "显示预览"}
            </button>
            <button
              type="button"
              onClick={stop}
              className="rounded-full border border-zinc-700 px-5 py-2 text-sm text-zinc-400 transition-colors hover:bg-zinc-900"
            >
              关闭摄像头
            </button>
          </div>
        </>
      ) : status === "idle" ? (
        <div className="flex aspect-video w-full items-center justify-center rounded-2xl border border-dashed border-zinc-600">
          <button
            type="button"
            onClick={start}
            className="rounded-full bg-zinc-100 px-5 py-2 text-sm font-medium text-zinc-950 transition-opacity hover:opacity-80"
          >
            开启摄像头
          </button>
        </div>
      ) : (
        <CameraPermissionGuide status={status} message={error} onRetry={start} />
      )}
    </section>
  );
}
