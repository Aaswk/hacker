/* ==================================================================
   物种档案 · 共享常量与工具（Step 7）
   ------------------------------------------------------------------
   /live 联调页与 / 桌面入口都要判断「样本是否够立案」，
   放在这里保持各入口的判断一致。
   ================================================================== */

/**
 * 档案累计至少 15 条观察记录后开放物种卡。
 */
export const SPECIES_CARD_MIN_OBSERVATIONS = 15;

/** 样本不足时的提示，按当前记录数轮换。 */
export const INSUFFICIENT_SAMPLE_LINES = [
  "小本子再攒几条记录，就能生成档案啦。",
  "档案还差几条观察，记录员先夹好书签。",
  "档案还在准备中，再一起观察一会儿吧。",
  "封面已经画好了，再添几条观察就能装订。",
] as const;

/** 按当前样本量挑一句台词（循环使用） */
export function pickInsufficientLine(count: number): string {
  return INSUFFICIENT_SAMPLE_LINES[count % INSUFFICIENT_SAMPLE_LINES.length];
}
