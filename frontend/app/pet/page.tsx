"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";

import { Button } from "animal-island-ui";
import "animal-island-ui/style";

import { PetDock } from "@/components/PetDock/PetDock";
import {
  pickInsufficientLine,
  SPECIES_CARD_MIN_OBSERVATIONS,
} from "@/components/SpeciesCard/archive";
import { usePetState } from "@/hooks/usePetState";
import { api } from "@/lib/api";
import type { SpeciesCard as SpeciesCardData } from "@/types/contract";

/* ==================================================================
   /pet —— 桌面桌宠页（给 Electron 壳加载）
   ------------------------------------------------------------------
   和桌面页（/）共用同一套桌宠外观，但整页透明、无任何背景：
   Electron 开的是 transparent 窗口，页面一有底色就会糊住桌面。

   鼠标穿透：整窗默认 ignoreMouseEvents(true)，这里把「哪些区域算桌宠」
   （[data-pet-hit] 的窗口内矩形）上报给主进程，由主进程轮询光标位置决定
   是否关穿透。命中判定完全在主进程侧，不依赖 setIgnoreMouseEvents(forward)
   是否把 mousemove 送到渲染进程——那条链路断掉就会出现「看得见、碰不到、
   拖不动」的幽灵窗口。

   窗口铺满主显示器工作区（边缘贴着屏幕边），所以这里就是「整块桌面」：
   桌宠能在整屏被拖动 / 溜达；日志抽屉从真实屏幕右缘缓缓滑入
   （panel 宽 430px、transition .36s，窗口够宽才看得出这段滑动）。
   弹层打开期间只把面板本身并入命中区，点面板外的桌面照常穿透，
   不会被这层置顶窗口吃掉点击；关闭走面板上的 × 或 Esc。

   数据源同桌面页：轮询 B 的 GET /observations（端口 8001）。
   不挂 pet.stageProps：窗口进进出出太频繁，会把「离开 / 回来」警戒刷爆。
   ================================================================== */

const PET_CSS = `
html, body { background: transparent !important; }
body { overflow: hidden; }
`;

/** Drawer / Modal 内部用 createPortal 挂到 document.body，必须关掉 SSR */
const LogDrawer = dynamic(
  () => import("@/components/LogDrawer/LogDrawer").then((m) => m.LogDrawer),
  { ssr: false },
);

const SpeciesCardDialog = dynamic(
  () => import("@/components/SpeciesCard/SpeciesCard").then((m) => m.SpeciesCard),
  { ssr: false },
);

export default function PetDesktopPage() {
  /** 右键菜单：隐藏气泡后不再弹气泡，只默默记录（队列照常走） */
  const [bubblesHidden, setBubblesHidden] = useState(false);
  /** 📓 日志 / 🧬 物种卡：小窗内就地弹出 */
  const [logOpen, setLogOpen] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);

  const pet = usePetState({ enabled: true, intervalMs: 2000 });
  const { push } = pet;

  /* 指针穿透：上报 [data-pet-hit] 的窗口内矩形，主进程据此轮询光标决定穿透 */
  useEffect(() => {
    const api = window.petAPI;
    if (!api?.setHitRects) return;

    let last = "";
    const report = () => {
      const rects = Array.from(
        document.querySelectorAll<HTMLElement>("[data-pet-hit]"),
      ).map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      });
      // 弹层打开时只把「面板本身」并入命中区（Drawer / Modal 的面板都是
      // role="dialog"）。窗口现在铺满整块工作区，若整窗上报，整个桌面都会被
      // 这层置顶窗口吃掉点击。关不掉的兜底：面板上的 × 或 Esc。
      if (logOpen || cardOpen) {
        document
          .querySelectorAll<HTMLElement>('[role="dialog"]')
          .forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              rects.push({
                left: r.left,
                top: r.top,
                width: r.width,
                height: r.height,
              });
            }
          });
      }
      const key = JSON.stringify(rects);
      if (key === last) return;
      last = key;
      api.setHitRects(rects);
    };

    report();
    const id = window.setInterval(report, 120);
    return () => {
      window.clearInterval(id);
      api.setHitRects([]);
    };
  }, [logOpen, cardOpen]);

  /* 物种卡档案：文案只来自 B 的 summary；累计条数决定能否立案 */
  const [card, setCard] = useState<SpeciesCardData | null>(null);
  const loadCard = useCallback(async () => {
    try {
      setCard(await api.getSpeciesCard());
    } catch {
      /* B 未启动 / 未接线时静默，不影响桌宠 */
    }
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => void loadCard(), 0);
    return () => window.clearTimeout(t);
  }, [loadCard]);

  /* 用 B 返回的 event_counts 求和，而不是本页轮询到的条数：
     后者在轮询未到时会误判成样本不足 */
  const archiveCount = Object.values(card?.event_counts ?? {}).reduce(
    (sum, n) => sum + n,
    0,
  );

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
    window.setTimeout(() => setCardOpen(true), 1400);
  }, [archiveCount, push]);

  return (
    /* data-animal-drawer-ignore：Drawer 打开时默认会把 body 下非 fixed 的子元素
       整体 scale(0.94)+blur 来「推背景」。桌面壳没有背景可推，硬推只会把桌宠
       缩小糊掉，还会和抽屉的滑入动画打架，所以让库跳过本页。 */
    <main
      data-animal-drawer-ignore
      className="relative h-screen w-screen overflow-hidden"
    >
      <style>{PET_CSS}</style>
      <PetDock
        mode="window"
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
                  ? "生成 HUMAN #001 物种卡"
                  : `样本不足，记录员拒绝立案（${archiveCount}/${SPECIES_CARD_MIN_OBSERVATIONS}）`
              }
              onClick={openSpeciesCard}
            >
              🧬 物种卡
            </Button>
          </>
        }
      />

      {/* 观察日志抽屉：从真实屏幕右缘滑入（窗口已铺满工作区，滑动肉眼可见） */}
      <LogDrawer
        open={logOpen}
        onClose={() => setLogOpen(false)}
        observations={pet.observations}
        subjectId="HUMAN_001"
      />

      {/* HUMAN #001 物种卡（无抓拍，渲染占位框） */}
      <SpeciesCardDialog open={cardOpen} onClose={() => setCardOpen(false)} />
    </main>
  );
}
