"use client";

import type { RefCallback } from "react";

interface CameraPreviewProps {
  attachVideo: RefCallback<HTMLVideoElement | null>;
  /** 演示时可以不露画面：用 CSS 隐藏，视频元素与媒体流保持存活，Step 2 仍能截帧 */
  visible: boolean;
}

export function CameraPreview({ attachVideo, visible }: CameraPreviewProps) {
  return (
    <div
      className={`relative aspect-video w-full overflow-hidden rounded-2xl bg-black ${
        visible ? "" : "invisible"
      }`}
    >
      <video
        ref={attachVideo}
        className="h-full w-full -scale-x-100 object-cover"
        autoPlay
        muted
        playsInline
      />
      {!visible && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-400">
          预览已隐藏，摄像头仍在采集
        </div>
      )}
    </div>
  );
}
