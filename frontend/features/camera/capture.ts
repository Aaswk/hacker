/**
 * 截帧：从视频流取一帧，降采样后转成图片 Blob。
 * A 只负责送画面，不做任何识别；画面不落盘，Blob 用完即被 GC。
 */

export interface CaptureOptions {
  /** 降采样：最长边像素上限，默认 1280（720p 上限，对齐 C 的要求） */
  maxEdge?: number;
  /** JPEG 质量，默认 0.7 */
  quality?: number;
}

export class CaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureError";
  }
}

export async function captureFrame(
  video: HTMLVideoElement | null,
  { maxEdge = 1280, quality = 0.7 }: CaptureOptions = {},
): Promise<Blob> {
  if (!video) {
    throw new CaptureError("截帧失败：视频元素未就绪");
  }

  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) {
    throw new CaptureError("截帧失败：画面尺寸为 0，视频尚未开始播放");
  }

  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new CaptureError("截帧失败：无法创建 canvas 上下文");
  }
  ctx.drawImage(video, 0, 0, targetWidth, targetHeight);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", quality);
  });
  if (!blob) {
    throw new CaptureError("截帧失败：图片编码返回空");
  }

  return blob;
}
