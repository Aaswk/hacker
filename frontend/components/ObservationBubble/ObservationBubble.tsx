"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Bubble, Fukidashi, Typewriter } from "react-fukidashi";
import type { FukidashiStyle, Placement } from "react-fukidashi";
import "react-fukidashi/style.css";

/* ==================================================================
   观察气泡（Step 4）
   ------------------------------------------------------------------
   气泡 UI + 打字机用 react-fukidashi 的 <Bubble> / <Typewriter>。
   「多条排队」不在组件内部维护：本组件永远只演 items[0]，
   演完（打字完成 + 停留 holdMs）回调 onDismiss(id)，
   父级（Step 5 的 usePetState）把它移出队列，队首换成下一条。
   这样队列状态只有一份，且组件内不在 effect / render 里同步 setState。

   两个出口：
     - ObservationBubble          自撑版面（Bubble 直接摆在父级给的坑里）
     - AnchoredObservationBubble  锚在某个点上（Fukidashi + floating-ui），
                                  贴屏幕边时自动翻到空的一侧 / 挪回屏内，
                                  「气泡被挡住」这件事交给组件自己解决
   两者共用同一套配色与内容层（chip + 打字机 + 播完出队）。
   ================================================================== */

/** 语气：普通观察 / 警戒 / 发现 */
export type BubbleTone = "normal" | "alert" | "discover";

export interface ObservationBubbleItem {
  /** 唯一标识，直接用 Observation.observation_id */
  id: number | string;
  /** 台词，只来自 B 的 message */
  message: string;
  /** 语气，决定气泡配色与标签，默认 normal */
  tone?: BubbleTone;
}

export interface ObservationBubbleProps {
  /** 待播队列，队首先播；父级负责出队 */
  items: readonly ObservationBubbleItem[];
  /** 一条演完后回调，父级据此把它移出队列；不传则仅自动隐藏 */
  onDismiss?: (id: number | string) => void;
  /** 打字速度，ms/字 */
  speed?: number;
  /** 打字结束后的停留时长，ms */
  holdMs?: number;
  className?: string;
}

interface ToneSpec {
  label: string;
  bg: string;
  edge: string;
  fg: string;
  chipBg: string;
  chipFg: string;
}

/* 三种语气 → 三套配色。统一走「厚描边 + 硬投影」的像素书页质感 */
const TONE: Record<BubbleTone, ToneSpec> = {
  normal: {
    label: "观察记录",
    bg: "#FDEBC7",
    edge: "#241c14",
    fg: "#241c14",
    chipBg: "#DEA86C",
    chipFg: "#241c14",
  },
  alert: {
    label: "警戒",
    bg: "#FFE1D3",
    edge: "#8f3016",
    fg: "#3a1408",
    chipBg: "#ff7a4d",
    chipFg: "#3a1408",
  },
  discover: {
    label: "新发现",
    bg: "#FCF2C0",
    edge: "#7c5a10",
    fg: "#3a2c08",
    chipBg: "#F2C245",
    chipFg: "#3a2c08",
  },
};

/* 语气配色 → react-fukidashi 的 CSS 变量。Bubble 自撑版与 Fukidashi 锚定版共用 */
function toneVars(tone: ToneSpec): FukidashiStyle {
  return {
    "--fukidashi-background": tone.bg,
    "--fukidashi-color": tone.fg,
    "--fukidashi-border-color": tone.edge,
    "--fukidashi-border-width": "2px",
    "--fukidashi-radius": "12px",
    "--fukidashi-padding": "16px 20px 18px",
    "--fukidashi-max-width": "25rem",
    "--fukidashi-shadow": `5px 5px 0 ${tone.edge}`,
  };
}

const STYLE_ID = "observation-bubble-css";
const CSS = `
.ob-wrap {
  animation: ob-pop 260ms cubic-bezier(0.2, 0.9, 0.2, 1) both;
  font-family: "Baloo 2", "ZCOOL KuaiLe", "YouYuan", "幼圆", "PingFang SC", "Microsoft YaHei", ui-rounded, system-ui, sans-serif;
}
@keyframes ob-pop {
  from { opacity: 0; transform: translateY(6px) scale(0.96); }
  to   { opacity: 1; transform: none; }
}
.ob-chip {
  display: inline-block;
  margin: 0 0 9px;
  padding: 3px 11px 4px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 800;
  line-height: 1.2;
  letter-spacing: 0.14em;
}
.ob-text {
  margin: 0;
  font-size: 17px;
  line-height: 1.9;
  letter-spacing: 0.03em;
  font-weight: 600;
  word-break: break-word;
}
@media (prefers-reduced-motion: reduce) {
  .ob-wrap { animation: none; }
}
/* 气泡整层不接管指针事件：
   Fukidashi 默认 portal 到 body，其 .fukidashi-positioner / .fukidashi-motion
   没有 pointer-events 声明（默认 auto），会盖在桌宠上方抢走 pointerdown →
   桌宠拖不动、入口按钮点不着；Electron 壳的 elementFromPoint 命中判定也会
   因此判成「不在桌宠上」而让整窗持续鼠标穿透。
   气泡本身不需要任何交互（只靠打字完成 + 定时 onDismiss 自动收起），全层放行是安全的。 */
.fukidashi-positioner,
.fukidashi-motion,
.fukidashi-bubble,
.fukidashi-content { pointer-events: none !important; }
`;

function useInjectedStyle() {
  useEffect(() => {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
  }, []);
}

/* 气泡「内容层」：标签 + 打字机 + 播完出队 / 自动隐藏。
   两种出口共用；它只负责内容与计时，不负责外壳（Bubble / Fukidashi 由外层给） */
function BubbleContent({
  item,
  onDismiss,
  speed,
  holdMs,
  onHidden,
}: {
  item: ObservationBubbleItem;
  onDismiss?: (id: number | string) => void;
  speed: number;
  holdMs: number;
  /** 无 onDismiss 时自行隐藏，顺带通知外层把整个气泡壳也收起 */
  onHidden?: () => void;
}) {
  const tone = TONE[item.tone ?? "normal"];
  const [typed, setTyped] = useState(false);

  // 回调放 ref，避免父级每次渲染换新函数时把停留计时器反复重置
  const dismissRef = useRef(onDismiss);
  const hiddenRef = useRef(onHidden);
  useEffect(() => {
    dismissRef.current = onDismiss;
    hiddenRef.current = onHidden;
  }, [onDismiss, onHidden]);

  useEffect(() => {
    if (!typed) return;
    const t = window.setTimeout(() => {
      const cb = dismissRef.current;
      if (cb) cb(item.id);
      else hiddenRef.current?.();
    }, holdMs);
    return () => window.clearTimeout(t);
  }, [typed, holdMs, item.id]);

  return (
    <>
      <span className="ob-chip" style={{ background: tone.chipBg, color: tone.chipFg }}>
        {tone.label}
      </span>
      <p className="ob-text">
        <Typewriter
          text={item.message}
          speed={speed}
          cursor={<span style={{ color: tone.chipBg }}>▍</span>}
          onComplete={() => setTyped(true)}
        />
      </p>
    </>
  );
}

/* 单条气泡（自撑版）。父级用 key={item.id} 挂载 → 换条即整体重置 */
function BubbleCard({
  item,
  onDismiss,
  speed,
  holdMs,
  className,
}: {
  item: ObservationBubbleItem;
  onDismiss?: (id: number | string) => void;
  speed: number;
  holdMs: number;
  className?: string;
}) {
  const tone = TONE[item.tone ?? "normal"];
  const [hidden, setHidden] = useState(false);

  if (hidden) return null;

  return (
    <div className={className ? `ob-wrap ${className}` : "ob-wrap"}>
      <Bubble
        variant="comic"
        tail={{ side: "bottom", offset: "50%", size: 12 }}
        style={toneVars(tone)}
      >
        <BubbleContent
          item={item}
          onDismiss={onDismiss}
          speed={speed}
          holdMs={holdMs}
          onHidden={() => setHidden(true)}
        />
      </Bubble>
    </div>
  );
}

export function ObservationBubble({
  items,
  onDismiss,
  speed = 42,
  holdMs = 2600,
  className,
}: ObservationBubbleProps) {
  useInjectedStyle();

  const head = items[0];
  if (!head) return null;

  return (
    <BubbleCard
      key={head.id}
      item={head}
      onDismiss={onDismiss}
      speed={speed}
      holdMs={holdMs}
      className={className}
    />
  );
}

/* ------------------------------------------------------------------
   锚定版：气泡挂在一个锚点上，贴屏幕边时由 floating-ui 自动翻边 / 收窄，
   即「气泡被挡住就换个方向显示」。拖动桌宠时锚点位置变化不会触发
   ResizeObserver / scroll 事件，所以开 trackAnchor 每帧追帧。
   Fukidashi 自己会渲染一层 Bubble，children 只能是「内容层」。
   ------------------------------------------------------------------ */
export interface AnchoredObservationBubbleProps extends ObservationBubbleProps {
  /** 锚点元素（通常是贴在桌宠头顶的隐形点） */
  anchor: ReactNode;
  /** 首选方向，默认上方；被挡时自动翻到空的一侧 */
  placement?: Placement;
  /** 静音：只叠透明，不卸载，保证打字机与出队照常走 */
  muted?: boolean;
  /** 外层包装（定位等） */
  anchorClassName?: string;
  anchorStyle?: CSSProperties;
}

function AnchoredCard({
  item,
  onDismiss,
  speed = 42,
  holdMs = 2600,
  anchor,
  placement,
  muted,
  anchorClassName,
  anchorStyle,
}: AnchoredObservationBubbleProps & { item: ObservationBubbleItem }) {
  const tone = TONE[item.tone ?? "normal"];
  const [hidden, setHidden] = useState(false);

  return (
    <Fukidashi
      anchor={anchor}
      open={!hidden}
      placement={placement ?? "top"}
      gap={8}
      collisionPadding={16}
      trackAnchor
      variant="comic"
      zIndex={900}
      className={[
        "pointer-events-none",
        muted ? "opacity-0" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      anchorClassName={anchorClassName}
      anchorStyle={anchorStyle}
      style={toneVars(tone)}
    >
      <span className="ob-wrap block">
        <BubbleContent
          item={item}
          onDismiss={onDismiss}
          speed={speed}
          holdMs={holdMs}
          onHidden={() => setHidden(true)}
        />
      </span>
    </Fukidashi>
  );
}

export function AnchoredObservationBubble({
  items,
  onDismiss,
  speed = 42,
  holdMs = 2600,
  anchor,
  placement,
  muted,
  anchorClassName,
  anchorStyle,
}: AnchoredObservationBubbleProps) {
  useInjectedStyle();

  const head = items[0];
  if (!head) return null;

  return (
    <AnchoredCard
      key={head.id}
      item={head}
      items={items}
      onDismiss={onDismiss}
      speed={speed}
      holdMs={holdMs}
      anchor={anchor}
      placement={placement}
      muted={muted}
      anchorClassName={anchorClassName}
      anchorStyle={anchorStyle}
    />
  );
}
