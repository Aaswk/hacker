"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";

import { Button } from "animal-island-ui";
import "animal-island-ui/style";

import { PetDock } from "@/components/PetDock/PetDock";
import {
  blobToDataUrl,
  pickInsufficientLine,
  SPECIES_CARD_MIN_OBSERVATIONS,
} from "@/components/SpeciesCard/archive";
import { captureFrame } from "@/features/camera/capture";
import { useFrameReporter } from "@/features/camera/useFrameReporter";
import { PermissionGate } from "@/features/desktop/PermissionGate";
import { useCamera } from "@/hooks/useCamera";
import { usePetState } from "@/hooks/usePetState";
import { api } from "@/lib/api";
import type { SpeciesCard as SpeciesCardData } from "@/types/contract";

/* ==================================================================
   Step 8 · 单屏桌面体验（/）
   ------------------------------------------------------------------
   全程只有一个界面——桌面本身：
     ① 进入：一张萌系授权卡（「我需要借用你的眼睛」）→ 授权摄像头
     ② 桌宠从屏幕右侧滑入，常驻右下角，气泡从它头顶弹出
     ③ 📓 / 🧬 两个入口长在桌宠身上，鼠标靠近桌宠才浮现
     ④ 摄像头画面不再预览：只留一个 1px 隐藏 video 挂着，保证物种卡还能抓帧
   ------------------------------------------------------------------
   数据来源：轮询 B 的 GET /observations（见 usePetState）。
   截帧上报（useFrameReporter）：授权完成 → 进入桌面后开始，每 500ms 把一帧
   交给 C 的 POST /frame；退出体验 / 组件卸载即停止。
   C 的新事件只留在 A 侧，A 不提交 B 的 /events，状态与文案仍由 B 的 /observations 决定。
   ================================================================== */

/** Drawer / Modal 内部用 createPortal 挂到 document.body，必须关掉 SSR */
const LogDrawer = dynamic(
  () => import("@/components/LogDrawer/LogDrawer").then((m) => m.LogDrawer),
  { ssr: false },
);

const SpeciesCardDialog = dynamic(
  () => import("@/components/SpeciesCard/SpeciesCard").then((m) => m.SpeciesCard),
  { ssr: false },
);

const DESKTOP_CSS = `
@keyframes dk-guide-in {
  0%   { opacity: 0; transform: translateY(-8px); }
  100% { opacity: 1; transform: none; }
}
@keyframes dk-guide-out {
  0%   { opacity: 1; }
  100% { opacity: 0; transform: translateY(-6px); }
}
.dk-guide { animation: dk-guide-in 420ms ease-out both; }
.dk-guide[data-leaving="true"] { animation: dk-guide-out 420ms ease-in both; }
@media (prefers-reduced-motion: reduce) {
  .dk-guide { animation: none; }
}
`;

export function DesktopExperience() {
  /* 进入体验的开关：授权成功或「先看看」后，桌宠登场 */
  const [entered, setEntered] = useState(false);
  /** 首次引导：一句提示，几秒后自动收回 */
  const [guideLeaving, setGuideLeaving] = useState(false);
  const [guideMounted, setGuideMounted] = useState(true);

  const [bubblesHidden, setBubblesHidden] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  /** 档案照是否已被 AI 动漫化重绘（/api/cartoon 成功后置真） */
  const [snapshotCartoon, setSnapshotCartoon] = useState(false);
  /** 抓拍后、重绘结果回来前：照片区显示「重绘中」，绝不先闪一张原图 */
  const [snapshotPending, setSnapshotPending] = useState(false);

  /* Step 5：进入后才开始轮询 B 的 /observations */
  const pet = usePetState({ enabled: entered, intervalMs: 2000 });
  // 解构出稳定引用：pet 每次渲染都是新对象，不能直接进 effect deps
  const push = pet.push;

  /* 摄像头：进入时由授权卡触发，不自动请求 */
  const camera = useCamera({ autoStart: false });
  const {
    start: startCamera,
    status: cameraStatus,
    error: cameraError,
    attachVideo,
    videoRef,
  } = camera;

  /* 授权成功 → 桌宠登场（延后一拍，避免 effect 内同步 setState） */
  useEffect(() => {
    if (cameraStatus !== "ready") return;
    const t = window.setTimeout(() => setEntered(true), 0);
    return () => window.clearTimeout(t);
  }, [cameraStatus]);

  /* Step 3：送帧上报链路（A → C 的 POST /frame，默认 http://localhost:8002/frame，500ms 一拍）。
     C 的新事件只交给 onEvent，A 不在这里提交 B 的 /events；
     桌宠状态与正式气泡继续由 usePetState 轮询 B 的 /observations 得到。 */
  const reporter = useFrameReporter({
    videoRef,
    cameraReady: cameraStatus === "ready",
  });
  // 解构出稳定引用：reporter 每次渲染都是新对象，但 start / stop 是空依赖 useCallback
  const reporterStart = reporter.start;
  const reporterStop = reporter.stop;

  /* 授权完成且已进入桌面 → 开始送帧；退出体验 / 组件卸载 → 停止。
     提前返回时不启动，授权卡阶段不会有任何帧流出。 */
  useEffect(() => {
    if (!entered || cameraStatus !== "ready") return;
    reporterStart();
    return () => reporterStop();
  }, [entered, cameraStatus, reporterStart, reporterStop]);

  /* 登场后先打个招呼：让评委立刻感到「它注意到我了」 */
  useEffect(() => {
    if (!entered) return;
    const t = window.setTimeout(
      () => push("normal", "发现一处温热的大型生命体。就是你吧。", "OBSERVING", "ambient"),
      700,
    );
    return () => window.clearTimeout(t);
  }, [entered, push]);

  /* 首次引导：9 秒后自动收回（先淡出，再卸载） */
  useEffect(() => {
    if (!entered) return;
    const out = window.setTimeout(() => setGuideLeaving(true), 9000);
    const done = window.setTimeout(() => setGuideMounted(false), 9450);
    return () => {
      window.clearTimeout(out);
      window.clearTimeout(done);
    };
  }, [entered]);

  /* 物种卡档案：文案只来自 B 的 summary；累计条数决定能否立案 */
  const [card, setCard] = useState<SpeciesCardData | null>(null);
  const loadCard = useCallback(async () => {
    try {
      setCard(await api.getSpeciesCard());
    } catch {
      /* B 未启动 / 未接线时静默，不影响桌面 */
    }
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => void loadCard(), 0);
    return () => window.clearTimeout(t);
  }, [loadCard]);

  /* 用 B 返回的 event_counts 求和，而不是本页的 pet.observations：
     后者依赖轮询，没轮询时为 0，会把门槛误判成不达标。 */
  const archiveCount = Object.values(card?.event_counts ?? {}).reduce(
    (sum, n) => sum + n,
    0,
  );

  /* 🧬 入口：样本不足 → 桌宠怼一句；足够 → 敲键盘 + 抓拍 + 浮现档案 */
  const openSpeciesCard = useCallback(() => {
    if (archiveCount < SPECIES_CARD_MIN_OBSERVATIONS) {
      push(
        "normal",
        `${pickInsufficientLine(archiveCount)}（${archiveCount}/${SPECIES_CARD_MIN_OBSERVATIONS}）`,
        "CONFUSED",
        "ambient",
      );
      return;
    }
    push("discover", "正在比对全部观察记录，生成物种档案…", "THINKING", "ambient");
    setSnapshot(null);
    setSnapshotCartoon(false);
    setSnapshotPending(false);
    void startCamera();
    window.setTimeout(() => setCardOpen(true), 1400);
  }, [archiveCount, push, startCamera]);

  /* 卡片浮现且摄像头就绪时抓一帧，作为物种卡的现场照片。
     时序：抓拍成功 → 立刻切到「重绘中」占位 → /api/cartoon 回来一次性显示最终图。
     不再先闪原图再替换；只有重绘失败时才退回原图，保证现场永远有画面。
     /api/cartoon 内部只有 AnimeGANv2(C 的 8002) 一个引擎：成功用动漫图，失败保留抓拍原图。 */
  useEffect(() => {
    if (!cardOpen || cameraStatus !== "ready") return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      void (async () => {
        let url = "";
        try {
          const blob = await captureFrame(videoRef.current);
          url = await blobToDataUrl(blob);
        } catch {
          return; // 抓拍失败就保留占位框，不影响物种卡本身
        }
        if (!url || cancelled) return;

        setSnapshotPending(true);
        try {
          const res = await fetch("/api/cartoon", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // data URL 去掉前缀，只传纯 base64
            body: JSON.stringify({ image: url.slice(url.indexOf(",") + 1), mime: "image/jpeg" }),
          });
          const data = (await res.json()) as { ok: boolean; image?: string; mime?: string };
          if (cancelled) return;
          if (data.ok && data.image) {
            setSnapshot(`data:${data.mime ?? "image/jpeg"};base64,${data.image}`);
            setSnapshotCartoon(true);
          } else {
            setSnapshot(url); // 重绘失败 → 退回抓拍原图
          }
        } catch {
          if (!cancelled) setSnapshot(url); // 网络异常 → 退回原图
        } finally {
          if (!cancelled) setSnapshotPending(false);
        }
      })();
    }, 260);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [cardOpen, cameraStatus, videoRef]);

  return (
    <main
      {...pet.stageProps}
      className="relative h-screen overflow-hidden text-zinc-100"
      style={{
        background:
          "radial-gradient(1200px 700px at 78% 88%, #1c2b33 0%, #0f1418 55%, #0b0e11 100%)",
      }}
    >
      <style>{DESKTOP_CSS}</style>

      {/* 点阵壁纸：让空桌面有质感，也衬托桌宠「常驻桌面」 */}
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          backgroundImage: "radial-gradient(rgba(255,255,255,.045) 1px, transparent 1px)",
          backgroundSize: "26px 26px",
        }}
      />

      {/* ① 首次进入：一张萌系授权卡 */}
      {!entered && (
        <PermissionGate
          status={cameraStatus}
          error={cameraError}
          onStart={() => void startCamera()}
          onSkip={() => setEntered(true)}
        />
      )}

      {/* 首次引导：一句提示，不超过一行 */}
      {entered && guideMounted && (
        <div className="pointer-events-none absolute inset-x-0 top-8 z-10 flex justify-center">
          <div
            className="dk-guide rounded-full px-5 py-2 text-[13px]"
            data-leaving={guideLeaving}
            style={{
              background: "rgba(255,255,255,.08)",
              border: "1px solid rgba(255,255,255,.12)",
              color: "#dfe7ec",
            }}
          >
            戳一戳右下角的小外星人，它一直在观察你
          </div>
        </div>
      )}

      {/* ② 桌宠：从右侧滑入，常驻右下角；📓 / 🧬 入口悬停才浮现 */}
      {entered && (
        <PetDock
          mode="page"
          petState={pet.petState}
          petX={pet.petX}
          queue={pet.queue}
          onDismiss={pet.dismiss}
          onPoke={pet.onPetClick}
          bubblesHidden={bubblesHidden}
          onToggleBubbles={() => setBubblesHidden((v) => !v)}
          actions={
            <>
              <Button
                type="default"
                size="small"
                title="打开观察日志"
                onClick={() => setLogOpen(true)}
              >
                📓 日志
              </Button>
              <Button
                type="primary"
                size="small"
                title={
                  archiveCount >= SPECIES_CARD_MIN_OBSERVATIONS
                    ? "生成 观测体 №001 物种卡"
                    : `样本不足，记录员拒绝立案（${archiveCount}/${SPECIES_CARD_MIN_OBSERVATIONS}）`
                }
                onClick={openSpeciesCard}
              >
                🧬 物种卡
              </Button>
            </>
          }
        />
      )}

      {/* ④ 摄像头画面不再预览：只留一个 1px 隐藏 video 挂着，保证物种卡还能抓帧；
             未就绪时给一颗极小的开关，方便重新授权 */}
      {entered && (
        <div className="absolute bottom-6 left-6 z-10">
          <video
            ref={attachVideo}
            className="pointer-events-none absolute h-px w-px opacity-0"
            muted
            playsInline
          />
          {cameraStatus !== "ready" && (
            <button
              type="button"
              onClick={() => void startCamera()}
              className="rounded-full px-3 py-1.5 text-[12px] transition-colors"
              style={{
                background: "rgba(255,255,255,.08)",
                border: "1px solid rgba(255,255,255,.14)",
                color: "#cfd8de",
              }}
            >
              📷{" "}
              {cameraStatus === "loading"
                ? "正在请求摄像头…"
                : cameraStatus === "denied"
                  ? "摄像头被拒绝 · 重新授权"
                  : cameraStatus === "unavailable"
                    ? "没有可用的摄像头"
                    : "开启摄像头"}
            </button>
          )}
        </div>
      )}

      {/* Step 6：从右侧滑出的观察日志抽屉 */}
      <LogDrawer
        open={logOpen}
        onClose={() => setLogOpen(false)}
        observations={pet.observations}
        subjectId="HUMAN_001"
      />

      {/* Step 7：观测体 №001 物种卡 */}
      <SpeciesCardDialog
        open={cardOpen}
        onClose={() => setCardOpen(false)}
        snapshot={snapshot}
        snapshotCartoon={snapshotCartoon}
        snapshotPending={snapshotPending}
      />
    </main>
  );
}
