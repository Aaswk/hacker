"use client";

import { useCallback, useEffect, useState } from "react";

import { ObservationBubble } from "@/components/ObservationBubble/ObservationBubble";
import { Pet } from "@/components/Pet/Pet";
import { usePetState } from "@/hooks/usePetState";
import { ApiError, api } from "@/lib/api";
import {
  HUMAN_EVENTS,
  type HumanEventType,
  type SpeciesCard,
} from "@/types/contract";

/* ==================================================================
   Step 5 联调页：桌宠 ← B 的真实 Observation
   ------------------------------------------------------------------
   轮询 B 的 GET /observations（默认 http://localhost:8001），
   新记录 → 桌宠动作 + 观察气泡 + 日志同时发生；
   物种卡文案取自 B 的 GET /species-card 的 summary 字段。
   接口地址见 A 文档 0.3，可用 NEXT_PUBLIC_API_BASE_URL 覆盖。
   ================================================================== */

const PET_STATE_LABEL: Record<string, string> = {
  IDLE: "发呆",
  OBSERVING: "观察中",
  THINKING: "记录中",
  CURIOUS: "好奇",
  ALERT: "警戒",
  EXCITED: "发现新行为",
  CONFUSED: "困惑",
};

const EVENT_LABEL: Record<HumanEventType, string> = {
  PERSON_ENTER: "有人进入",
  DRINKING: "喝水",
  STRETCHING: "伸懒腰",
  PERSON_LEFT: "离开",
  PERSON_RETURNED: "回来",
  UNKNOWN: "未知行为",
};

export default function LivePage() {
  /* Step 5：状态映射层。enabled=true 即开始轮询 B 的 /observations */
  const [watching, setWatching] = useState(false);
  const pet = usePetState({ enabled: watching, intervalMs: 2000 });

  /* 联调用：直接 POST /events 造一条，用来代替 C 的识别结果（注意会写入 B 的库） */
  const [event, setEvent] = useState<HumanEventType>("DRINKING");
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  const postTestEvent = useCallback(async () => {
    setPosting(true);
    setPostError(null);
    try {
      const created = await api.postEvent({
        subject_id: "HUMAN_001",
        event,
        confidence: 0.9,
        timestamp: new Date().toISOString(),
      });
      // 直连响应先喂一次；轮询拿到同一条时由 observation_id 去重
      pet.handleObservation(created);
    } catch (err) {
      setPostError(err instanceof ApiError ? err.message : "POST /events 失败");
    } finally {
      setPosting(false);
    }
  }, [event, pet]);

  /* 物种卡：文案只来自 B 的 summary 字段 */
  const [card, setCard] = useState<SpeciesCard | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);

  const loadCard = useCallback(async () => {
    try {
      setCard(await api.getSpeciesCard());
      setCardError(null);
    } catch (err) {
      setCardError(err instanceof ApiError ? err.message : "读取物种卡失败");
    }
  }, []);

  useEffect(() => {
    // 延到下一个 tick 再拉，避免在 effect 里同步 setState
    const t = window.setTimeout(() => void loadCard(), 0);
    return () => window.clearTimeout(t);
  }, [loadCard]);

  const cardCounts = Object.entries(card?.event_counts ?? {});

  return (
    <main className="min-h-screen bg-zinc-900 px-6 py-10 text-zinc-100">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <h1 className="text-lg font-medium">实时观察站</h1>
          <p className="text-xs text-zinc-500">
            Step 5 · 状态映射层：B 的 Observation → 桌宠动作 + 观察气泡 + 观察日志
          </p>
        </header>

        <div className="grid gap-8 lg:grid-cols-[1fr_1fr]">
          {/* 左：桌宠 + 气泡 */}
          <section className="flex flex-col gap-5 rounded-xl border border-zinc-800 bg-zinc-950/60 px-6 py-8">
            <div
              {...pet.stageProps}
              className="relative mx-auto flex w-full flex-col gap-3 rounded-2xl border-2 border-dashed border-zinc-700/80 bg-zinc-900/40 px-4 pb-5 pt-3"
            >
              <div className="self-start rounded bg-zinc-800/80 px-2 py-0.5 font-mono text-[10px] tracking-[0.2em] text-zinc-500">
                OBSERVATION CHAMBER · 观察舱
              </div>

              <div className="relative flex w-full justify-center pt-2">
                <div className="pointer-events-none absolute bottom-full left-1/2 flex w-full -translate-x-1/2 justify-center pb-1">
                  <ObservationBubble items={pet.queue} onDismiss={pet.dismiss} />
                </div>
                <div
                  className="w-full max-w-[220px] cursor-pointer select-none"
                  style={{
                    transform: `translateX(${pet.petX}px)`,
                    transition: "transform 1.7s linear",
                  }}
                  onClick={pet.onPetClick}
                  title="戳一戳"
                >
                  <Pet pet_state={pet.petState} />
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => setWatching((v) => !v)}
                className={
                  "rounded-full border px-3 py-1.5 text-xs transition-colors " +
                  (watching
                    ? "border-emerald-400 bg-emerald-400/10 text-emerald-200"
                    : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200")
                }
              >
                {watching ? "● 正在轮询 B /observations" : "○ 开始观察（轮询 B）"}
              </button>
            </div>

            {/* 联调用：没有 C 的时候手动造一条事件 */}
            <div className="flex flex-wrap items-center justify-center gap-2 border-t border-zinc-800 pt-4">
              <select
                value={event}
                onChange={(e) => setEvent(e.target.value as HumanEventType)}
                className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-300"
              >
                {HUMAN_EVENTS.map((e) => (
                  <option key={e} value={e}>
                    {EVENT_LABEL[e]}（{e}）
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void postTestEvent()}
                disabled={posting}
                className="rounded-full border border-sky-700/70 px-3 py-1.5 text-xs text-sky-300 transition-colors hover:border-sky-500 hover:text-sky-100 disabled:opacity-50"
              >
                {posting ? "提交中…" : "POST /events 造一条（联调）"}
              </button>
            </div>

            <div className="flex flex-col items-center gap-1 text-center font-mono text-[11px] text-zinc-600">
              <div>
                pet_state = &quot;{pet.petState}&quot; ·{" "}
                {PET_STATE_LABEL[pet.petState] ?? "巡逻中"} · 气泡队列{" "}
                {pet.queue.length} 条
              </div>
              <div>本次已播 {pet.log.length} 条 · 已处理到 id {pet.maxObservationId}</div>
              {pet.pollError ? (
                <div className="text-orange-400">轮询失败：{pet.pollError}</div>
              ) : null}
              {postError ? <div className="text-orange-400">{postError}</div> : null}
            </div>
          </section>

          {/* 右：日志 + 物种卡 */}
          <div className="flex flex-col gap-8">
            <section className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 px-6 py-6">
              <div className="flex items-baseline justify-between">
                <h2 className="text-sm font-medium text-zinc-300">
                  XENO RESEARCH DATABASE · HUMAN OBSERVATION LOG
                </h2>
                <span className="font-mono text-[10px] text-zinc-600">
                  {pet.observations.length} 条
                </span>
              </div>
              <div className="max-h-80 overflow-y-auto pr-1">
                {pet.observations.length === 0 ? (
                  <p className="py-6 text-center text-xs text-zinc-600">
                    {watching ? "等待 B 的新观察…" : "点「开始观察」后从 B 拉取日志"}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {pet.observations.map((it) => (
                      <li
                        key={it.observation_id}
                        className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2"
                      >
                        <div className="flex items-center justify-between font-mono text-[10px] text-zinc-500">
                          <span>#{it.observation_id}</span>
                          <span>
                            {it.event} · {it.pet_state}
                          </span>
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-zinc-300">
                          {it.message}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            <section className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 px-6 py-6">
              <div className="flex items-baseline justify-between">
                <h2 className="text-sm font-medium text-zinc-300">
                  HUMAN #001 · SPECIES CARD
                </h2>
                <button
                  type="button"
                  onClick={() => void loadCard()}
                  className="rounded-full border border-zinc-700 px-3 py-1 text-[11px] text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
                >
                  刷新
                </button>
              </div>
              {cardError ? (
                <p className="text-xs text-orange-400">读取失败：{cardError}</p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-zinc-500">
                    <span>subject_id: {card?.subject_id ?? "—"}</span>
                    {cardCounts.map(([key, value]) => (
                      <span key={key}>
                        {key} × {value}
                      </span>
                    ))}
                  </div>
                  <div>
                    <div className="font-mono text-[10px] tracking-[0.2em] text-zinc-600">
                      RESEARCHER NOTE（来自 B 的 summary 字段）
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-zinc-200">
                      {card?.summary ? card.summary : "—"}
                    </p>
                  </div>
                </>
              )}
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}
