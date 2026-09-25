"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";

import { ObservationBubble } from "@/components/ObservationBubble/ObservationBubble";
import { Pet } from "@/components/Pet/Pet";
import { captureFrame } from "@/features/camera/capture";
import { useCamera } from "@/hooks/useCamera";
import { usePetState } from "@/hooks/usePetState";
import { ApiError, api } from "@/lib/api";
import {
  HUMAN_EVENTS,
  type HumanEventType,
  type SpeciesCard,
} from "@/types/contract";

/* ==================================================================
   Step 5 + Step 6 + Step 7 联调页
   ------------------------------------------------------------------
   轮询 B 的 GET /observations（默认 http://localhost:8001），
   新记录 → 桌宠动作 + 观察气泡 + 抽屉时间线同时发生；
   Step 7 点击 🧬 → 桌宠先敲键盘（THINKING），再浮现 HUMAN #001 物种卡；
   物种卡数据取自 B 的 GET /species-card（summary + event_counts）。
   接口地址见 A 文档 0.3，可用 NEXT_PUBLIC_API_BASE_URL 覆盖。
   ================================================================== */

/**
 * Step 6/7 的抽屉与物种卡来自 animal-island-ui，内部用 createPortal 挂到
 * document.body，服务端渲染会直接抛错，所以关掉 SSR、只在客户端加载。
 */
const LogDrawer = dynamic(
  () => import("@/components/LogDrawer/LogDrawer").then((m) => m.LogDrawer),
  { ssr: false },
);

const SpeciesCardDialog = dynamic(
  () => import("@/components/SpeciesCard/SpeciesCard").then((m) => m.SpeciesCard),
  { ssr: false },
);

/** Blob → data URL，供物种卡展示抓拍照片（用完即随 state 释放，不落盘） */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

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

/**
 * 立案门槛：档案累计记录不足 15 条，记录员拒绝建卡。
 * 样本太薄时产出的档案没有研究价值，也会让「Aha Moment」廉价化。
 */
const SPECIES_CARD_MIN_OBSERVATIONS = 15;

/** 样本不足时记录员的台词，按当前样本量轮换，免得每次都被同一句怼回去 */
const INSUFFICIENT_SAMPLE_LINES = [
  "样本量不足，不予立案。继续监视。",
  "就这点记录，也想让我出档案？",
  "数据太薄。记录员不是算命的。",
  "本档案暂不受理。请把样本攒厚一点。",
];

export default function LivePage() {
  /* Step 5：状态映射层。enabled=true 即开始轮询 B 的 /observations */
  const [watching, setWatching] = useState(false);
  const pet = usePetState({ enabled: watching, intervalMs: 2000 });

  /* Step 6：桌宠旁边的 📓 打开观察日志抽屉 */
  const [logOpen, setLogOpen] = useState(false);

  /* Step 7：🧬 物种卡。先敲键盘 → 抓拍 → 浮现卡片 */
  const [cardOpen, setCardOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  // 只在用户点击时才请求权限，避免进页面就弹摄像头
  const camera = useCamera({ autoStart: false });
  const {
    start: startCamera,
    status: cameraStatus,
    attachVideo: attachCameraVideo,
    videoRef: cameraVideoRef,
  } = camera;

  /* 物种卡档案：文案只来自 B 的 summary 字段；累计条数决定能否立案 */
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

  /* 用 B 返回的 event_counts 求和，而不是本页的 pet.observations：
     后者依赖「开始观察」轮询，没轮询时为 0，会把门槛误判成不达标。 */
  const archiveCount = Object.values(card?.event_counts ?? {}).reduce(
    (sum, n) => sum + n,
    0,
  );
  const canOpenSpeciesCard = archiveCount >= SPECIES_CARD_MIN_OBSERVATIONS;

  const openSpeciesCard = useCallback(() => {
    // 样本不足：桌宠切困惑、怼一句就打回去，不弹卡片
    if (archiveCount < SPECIES_CARD_MIN_OBSERVATIONS) {
      const line =
        INSUFFICIENT_SAMPLE_LINES[archiveCount % INSUFFICIENT_SAMPLE_LINES.length];
      pet.push(
        "normal",
        `${line}（${archiveCount}/${SPECIES_CARD_MIN_OBSERVATIONS}）`,
        "CONFUSED",
        "ambient",
      );
      return;
    }
    pet.push("discover", "正在比对全部观察记录，生成物种档案…", "THINKING", "ambient");
    setSnapshot(null);
    void startCamera();
    // 先让桌宠敲一会儿键盘，再把档案推到台前
    window.setTimeout(() => setCardOpen(true), 1400);
  }, [archiveCount, pet, startCamera]);

  /* 卡片浮现且摄像头就绪时抓一帧，作为物种卡的现场照片 */
  useEffect(() => {
    if (!cardOpen || cameraStatus !== "ready") return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          const blob = await captureFrame(cameraVideoRef.current);
          const url = await blobToDataUrl(blob);
          if (!cancelled) setSnapshot(url);
        } catch {
          /* 抓拍失败就保留占位框，不影响物种卡本身 */
        }
      })();
    }, 260);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [cardOpen, cameraStatus, cameraVideoRef]);

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
      // 记完立刻刷新档案计数，右栏的立案进度与门槛要跟着动
      void loadCard();
    } catch (err) {
      setPostError(err instanceof ApiError ? err.message : "POST /events 失败");
    } finally {
      setPosting(false);
    }
  }, [event, loadCard, pet]);

  /* 物种卡：文案只来自 B 的 summary 字段 */
  const cardCounts = Object.entries(card?.event_counts ?? {});

  return (
    <main className="min-h-screen bg-zinc-900 px-6 py-10 text-zinc-100">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <h1 className="text-lg font-medium">实时观察站</h1>
          <p className="text-xs text-zinc-500">
            Step 5 + Step 6 + Step 7 · B 的 Observation → 桌宠动作 + 观察气泡 + 观察日志抽屉 +
            🧬 物种卡（animal-island-ui + NumberFlow）
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

              {/* Step 6 入口：桌宠旁边的 📓 */}
              <button
                type="button"
                onClick={() => setLogOpen(true)}
                title="打开观察日志（Step 6）"
                className="rounded-full border border-amber-600/60 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200 transition-colors hover:border-amber-400 hover:text-amber-50"
              >
                <span className="mr-1">📓</span>观察日志
              </button>

              {/* Step 7 入口：桌宠旁边的 🧬。样本不足时可点，但会被记录员打回 */}
              <button
                type="button"
                onClick={openSpeciesCard}
                title={
                  canOpenSpeciesCard
                    ? "生成物种卡（Step 7）"
                    : `样本不足，记录员拒绝立案（${archiveCount}/${SPECIES_CARD_MIN_OBSERVATIONS}）`
                }
                className={
                  "rounded-full border px-3 py-1.5 text-xs transition-colors " +
                  (canOpenSpeciesCard
                    ? "border-emerald-600/60 bg-emerald-500/10 text-emerald-200 hover:border-emerald-400 hover:text-emerald-50"
                    : "border-zinc-700 bg-zinc-800/40 text-zinc-500 hover:border-zinc-600 hover:text-zinc-400")
                }
              >
                <span className="mr-1">🧬</span>
                {canOpenSpeciesCard
                  ? "HUMAN #001"
                  : `样本不足 ${archiveCount}/${SPECIES_CARD_MIN_OBSERVATIONS}`}
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

          {/* 右：观察日志入口 + 物种卡 */}
          <div className="flex flex-col gap-8">
            <section className="flex flex-col gap-3 rounded-xl border border-amber-900/40 bg-amber-950/10 px-6 py-6">
              <div className="flex items-baseline justify-between">
                <h2 className="text-sm font-medium text-amber-200/90">
                  XENO RESEARCH DATABASE · HUMAN OBSERVATION LOG
                </h2>
                <span className="font-mono text-[10px] text-zinc-600">
                  {pet.observations.length} 条
                </span>
              </div>
              <p className="text-xs leading-relaxed text-zinc-400">
                Step 6：点击桌宠旁边的 📓，从屏幕右侧滑出观察日志抽屉——时间线由
                animal-island-ui 的 Drawer / Card / Tag / Progress 拼成，含观察描述、
                当前假说、置信度条与 HUMAN #001 的累计行为归类。
              </p>
              <button
                type="button"
                onClick={() => setLogOpen(true)}
                className="self-start rounded-full border border-amber-600/60 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-100 transition-colors hover:border-amber-400 hover:text-amber-50"
              >
                📓 打开 HUMAN OBSERVATION LOG
              </button>
            </section>

            <section className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 px-6 py-6">
              <div className="flex items-baseline justify-between">
                <h2 className="text-sm font-medium text-zinc-300">
                  HUMAN #001 · 物种档案
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
                  <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-[11px] leading-relaxed">
                    <div className="flex items-baseline justify-between">
                      <span className="text-zinc-400">立案样本</span>
                      <span
                        className={
                          "font-mono " +
                          (canOpenSpeciesCard ? "text-emerald-300" : "text-amber-300")
                        }
                      >
                        {archiveCount} / {SPECIES_CARD_MIN_OBSERVATIONS} 次
                      </span>
                    </div>
                    <div className="mt-1 text-zinc-500">
                      {canOpenSpeciesCard
                        ? "样本量已达标，记录员同意立案。"
                        : `样本不足，记录员拒绝立案。还差 ${SPECIES_CARD_MIN_OBSERVATIONS - archiveCount
                        } 次观察。`}
                    </div>
                  </div>
                  <div>
                    <div className="font-mono text-[10px] tracking-[0.2em] text-zinc-600">
                      记录员手记（来自 B 的 summary 字段）
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-zinc-200">
                      {card?.summary ? card.summary : "—"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={openSpeciesCard}
                    className={
                      "self-start rounded-full border px-4 py-1.5 text-xs transition-colors " +
                      (canOpenSpeciesCard
                        ? "border-emerald-600/60 bg-emerald-500/10 text-emerald-100 hover:border-emerald-400 hover:text-emerald-50"
                        : "border-zinc-700 bg-zinc-800/40 text-zinc-500 hover:border-zinc-600 hover:text-zinc-400")
                    }
                  >
                    {canOpenSpeciesCard
                      ? "🧬 生成 HUMAN #001 物种卡"
                      : `🧬 样本不足 ${archiveCount}/${SPECIES_CARD_MIN_OBSERVATIONS}`}
                  </button>
                </>
              )}
            </section>
          </div>
        </div>
      </div>

      {/* Step 6：从右侧滑出的观察日志抽屉 */}
      <LogDrawer
        open={logOpen}
        onClose={() => setLogOpen(false)}
        observations={pet.observations}
        subjectId="HUMAN_001"
      />

      {/* Step 7：HUMAN #001 物种卡（game 异形弹窗） */}
      <SpeciesCardDialog
        open={cardOpen}
        onClose={() => setCardOpen(false)}
        snapshot={snapshot}
      />

      {/* 抓拍用的隐藏预览：元素保持挂载，流才不断（Step 2 截帧依赖这一点） */}
      <video
        ref={attachCameraVideo}
        muted
        autoPlay
        playsInline
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          opacity: 0,
          pointerEvents: "none",
        }}
      />
    </main>
  );
}
