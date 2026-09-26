/* ==================================================================
   物种档案 · 共享常量与工具（Step 7）
   ------------------------------------------------------------------
   /live 联调页与 / 桌面入口都要判断「样本是否够立案」，
   并把抓拍结果转成物种卡能显示的照片。放在这里避免两处各写一份。
   ================================================================== */

/**
 * 立案门槛：档案累计记录不足 15 条，记录员拒绝建卡。
 * 样本太薄时产出的档案没有研究价值，也会让「Aha Moment」廉价化。
 */
export const SPECIES_CARD_MIN_OBSERVATIONS = 15;

/** 样本不足时记录员的台词，按当前样本量轮换，免得每次都被同一句怼回去 */
export const INSUFFICIENT_SAMPLE_LINES = [
  "样本量不足，不予立案。继续监视。",
  "就这点记录，也想让我出档案？",
  "数据太薄。记录员不是算命的。",
  "本档案暂不受理。请把样本攒厚一点。",
] as const;

/** 按当前样本量挑一句台词（循环使用） */
export function pickInsufficientLine(count: number): string {
  return INSUFFICIENT_SAMPLE_LINES[count % INSUFFICIENT_SAMPLE_LINES.length];
}

/** Blob → data URL，供物种卡展示抓拍照片（用完即随 state 释放，不落盘） */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
