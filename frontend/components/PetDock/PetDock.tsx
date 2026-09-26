"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { AnchoredObservationBubble } from "@/components/ObservationBubble/ObservationBubble";
import type { ObservationBubbleItem } from "@/components/ObservationBubble/ObservationBubble";
import { Pet } from "@/components/Pet/Pet";
import type { PetVisualState } from "@/components/Pet/Pet";

/* ==================================================================
   桌宠外壳 PetDock —— 桌面页（/）与 Electron 桌面壳（/pet）共用
   ------------------------------------------------------------------
   把「桌宠怎么摆、怎么被戳、怎么被拖、右键菜单」收在一处，
   两个宿主只负责给状态和入口按钮：

     - 气泡：锚在桌宠头顶（AnchoredObservationBubble），贴屏幕边时自动翻边避让
     - 入口：📓 / 🧬 等按钮在「鼠标靠近桌宠或按钮区域」时浮现，
             热区把桌宠与按钮之间那道 12px 缝隙也算进去，移向按钮不会中途消失
     - 单击：戳一戳（onPoke）；长按 180ms 才进入拖动，避免误移
     - 拖动：改自身 left/top（左右上下各至少留 60% 在屏内）。
             Electron 壳的窗口已铺满整块工作区，所以两种模式都是「拖桌宠自己」，
             移窗没有意义；window 模式额外通知主进程「拖动中」保持不穿透
     - 右键：隐藏气泡 / 显示气泡（静音后仍照常记录，只是不弹）+ 退出桌宠
     - 静音：不卸载 ObservationBubble，只叠一层透明，让打字机与出队照常走，
             否则队列会卡死、桌宠的状态表演也会停
   ------------------------------------------------------------------
   data-pet-hit：Electron 壳用它做「指针是否落在桌宠上」的命中判定，
                 命中则关掉整窗鼠标穿透。
   ================================================================== */

const LONG_PRESS_MS = 180;
const DRAG_SLOP = 4;
const SUPPRESS_CLICK_MS = 350;
const MENU_W = 176;
const MENU_H = 92;
/** 悬停热区外扩量；大于按钮与桌宠之间的 12px 缝隙，保证鼠标移过去不会掉出热区 */
const HOVER_PAD = 12;
/** 离开热区后延迟收起，避免边缘抖动闪没 */
const HIDE_DELAY = 180;
/** 拖动时至少留在屏内的比例（0.6 = 每边至少 60% 可见） */
const KEEP_VISIBLE = 0.6;
/** 桌宠盒子宽（与下面 anchorClass 的 w-[200px] 保持一致） */
const PET_BOX_W = 200;
/** 入口按钮列宽，以及它与桌宠盒子之间的缝隙（mr-3 = 12px） */
const BTN_W = 93;
const BTN_GAP = 12;
/** 桌宠溜达时桌宠自身的位移动画时长；按钮换边要跟它走同一条曲线才不会各走各的 */
const WALK_MS = 1700;
/** 按钮「从桌宠右侧切到左侧」所需的横向位移：跨过盒宽 + 左右各一条缝隙 + 按钮自身宽 */
const BTN_SIDE_SHIFT = PET_BOX_W + BTN_GAP + BTN_W + BTN_GAP;
/** 按钮贴到桌宠右侧时，其左缘要越过桌宠左缘的距离：盒宽 + 缝隙 */
const BTN_RIGHT_EDGE = PET_BOX_W + BTN_GAP;

const STYLE_ID = "pet-dock-css";
const CSS = `
@keyframes pd-in {
  0%   { opacity: 0; transform: translateX(46%) translateY(14px) scale(.92); }
  70%  { opacity: 1; transform: translateX(-3%) translateY(0) scale(1.01); }
  100% { opacity: 1; transform: none; }
}
.pd-in { animation: pd-in 720ms cubic-bezier(.2,1.35,.35,1) both; }
@media (prefers-reduced-motion: reduce) {
  .pd-in { animation: none; }
}
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

/** 点在按钮 / 链接上时，不算「戳桌宠」，也不该触发拖动 */
function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("button, a, input, [data-no-poke]") !== null
  );
}

export interface PetDockProps {
  /** page：网页桌面页；window：Electron 透明小窗 */
  mode: "page" | "window";
  petState: PetVisualState;
  /** 待机溜达的左右偏移（±100），只影响桌宠本体 */
  petX: number;
  queue: readonly ObservationBubbleItem[];
  onDismiss: (id: number | string) => void;
  /** 单击戳一戳 */
  onPoke: () => void;
  /** 悬停才浮现的入口按钮（📓 日志 / 🧬 物种卡） */
  actions?: ReactNode;
  /** 是否已静音气泡（右键菜单切换） */
  bubblesHidden: boolean;
  onToggleBubbles: () => void;
}

export function PetDock({
  mode,
  petState,
  petX,
  queue,
  onDismiss,
  onPoke,
  actions,
  bubblesHidden,
  onToggleBubbles,
}: PetDockProps) {
  useInjectedStyle();

  const rootRef = useRef<HTMLDivElement | null>(null);
  /** 悬停入口按钮所在容器，用于把按钮区域并入热区 */
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const pressTimerRef = useRef<number | null>(null);
  const draggingRef = useRef(false);
  const suppressClickRef = useRef(false);
  const movedRef = useRef(false);
  /** 正在进行的拖拽的拆除函数，卸载时兜底 */
  const teardownRef = useRef<(() => void) | null>(null);

  /** 被拖走后的落脚点；null = 用默认锚点 */
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  /** 右键菜单位置（视口坐标）；null = 未打开 */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /** 入口按钮是否浮现（鼠标靠近桌宠或按钮区域时显示） */
  const [actionsOpen, setActionsOpen] = useState(false);
  /** 是否处于长按拖动中（只影响光标形状，不能常驻 pressing 状态） */
  const [dragging, setDragging] = useState(false);

  const clearPressTimer = () => {
    if (pressTimerRef.current !== null) {
      window.clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || isInteractiveTarget(e.target)) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;

    const origin = {
      x: e.clientX,
      y: e.clientY,
      left: rect.left,
      top: rect.top,
      w: rect.width,
      h: rect.height,
    };
    movedRef.current = false;
    draggingRef.current = false;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - origin.x;
      const dy = ev.clientY - origin.y;
      if (Math.abs(dx) > DRAG_SLOP || Math.abs(dy) > DRAG_SLOP) movedRef.current = true;
      if (!draggingRef.current) return;
      // 左右 / 上下都至少留 KEEP_VISIBLE 比例在屏内，桌宠不会被拖到只剩一角
      const keepW = origin.w * KEEP_VISIBLE;
      const keepH = origin.h * KEEP_VISIBLE;
      const minX = keepW - origin.w;
      const minY = keepH - origin.h;
      // 视口小于桌宠时区间会反转，用 max 兜底成单点，避免抖动
      const maxX = Math.max(minX, window.innerWidth - keepW);
      const maxY = Math.max(minY, window.innerHeight - keepH);
      setPos({
        x: Math.min(Math.max(minX, origin.left + dx), maxX),
        y: Math.min(Math.max(minY, origin.top + dy), maxY),
      });
    };

    const onUp = () => {
      clearPressTimer();
      if (draggingRef.current) {
        draggingRef.current = false;
        setDragging(false);
        if (mode === "window") window.petAPI?.dragEnd();
        // 拖动松手后往往还会补一个 click，别让它变成「戳」
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, SUPPRESS_CLICK_MS);
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      teardownRef.current = null;
    };

    clearPressTimer();
    pressTimerRef.current = window.setTimeout(() => {
      pressTimerRef.current = null;
      draggingRef.current = true;
      setDragging(true);
      // window 模式：让主进程在拖动期间保持「不穿透」，
      // 否则指针一甩出桌宠，主进程立刻恢复穿透、pointermove 就断了。
      if (mode === "window") window.petAPI?.dragStart();
      // 接管当前位置，避免一按下就跳到锚点
      setPos({ x: origin.left, y: origin.top });
    }, LONG_PRESS_MS);

    teardownRef.current = () => {
      clearPressTimer();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (movedRef.current || isInteractiveTarget(e.target)) return;
    onPoke();
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    setMenu({
      x: Math.max(8, Math.min(e.clientX, window.innerWidth - MENU_W - 8)),
      y: Math.max(8, Math.min(e.clientY, window.innerHeight - MENU_H - 8)),
    });
  };

  /* 卸载时清掉可能还挂着的拖拽监听（ref 稳定，空依赖即可） */
  useEffect(
    () => () => {
      if (pressTimerRef.current !== null) window.clearTimeout(pressTimerRef.current);
      teardownRef.current?.();
    },
    [],
  );

  /* 悬停入口热区：桌宠本体 + 按钮容器各外扩 HOVER_PAD，
     两者间的 12px 缝隙被覆盖，鼠标从桌宠移向按钮的整段路径都算「靠近」。
     网页版与 Electron 小窗一致：按钮都是「鼠标靠近才浮现」。 */
  const hasActions = Boolean(actions);
  useEffect(() => {
    if (!hasActions) return;
    let hideTimer: number | null = null;
    const clearHide = () => {
      if (hideTimer !== null) {
        window.clearTimeout(hideTimer);
        hideTimer = null;
      }
    };
    const hit = (el: HTMLElement | null, x: number, y: number) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return (
        x >= r.left - HOVER_PAD &&
        x <= r.right + HOVER_PAD &&
        y >= r.top - HOVER_PAD &&
        y <= r.bottom + HOVER_PAD
      );
    };
    const onMove = (e: PointerEvent) => {
      if (hit(rootRef.current, e.clientX, e.clientY) || hit(actionsRef.current, e.clientX, e.clientY)) {
        clearHide();
        setActionsOpen((v) => (v ? v : true));
        return;
      }
      if (hideTimer === null) {
        hideTimer = window.setTimeout(() => {
          hideTimer = null;
          setActionsOpen(false);
        }, HIDE_DELAY);
      }
    };
    window.addEventListener("pointermove", onMove);
    return () => {
      clearHide();
      window.removeEventListener("pointermove", onMove);
    };
  }, [hasActions]);

  /* 默认锚点：被拖过就改走 fixed + left/top（pos）。
     window 模式（Electron）居中贴底：溜达的 petX 是围绕锚点对称展开的，
     居中才能让左右溜达的余量一致。 */
  const anchorClass =
    pos !== null
      ? "fixed w-[200px]"
      : mode === "window"
        ? "absolute bottom-14 left-1/2 w-[200px] -translate-x-1/2"
        : "absolute bottom-8 right-56 w-[200px]";

  /* 入口按钮列的横向位置：用一个连续的 translateX 表达（不再切换 left-/right-full
     布局类，否则换边是瞬时的、会「跳」）。基准位固定为「桌宠盒子右侧 12px」
     （right-full mr-3），于是
       D = petX           → 按钮贴到桌宠右侧
       D = petX + 317     → 按钮贴到桌宠左侧（跨过盒宽 + 两条缝隙 + 按钮自身宽）
     右侧放不下（会出屏）时改走左侧；420 宽小窗里 petX > 5px 就会切到左侧。
     因为走的是同一条 transform 过渡，换边时按钮会从桌宠身后平滑「滑过」。 */
  const [fit, setFit] = useState<{ left: number; vw: number }>({ left: 0, vw: 0 });
  useEffect(() => {
    if (!hasActions) return;
    const measure = () => {
      const r = rootRef.current?.getBoundingClientRect();
      setFit({ left: r ? r.left : 0, vw: window.innerWidth });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [hasActions, mode, pos]);

  const canRight =
    fit.vw === 0 || fit.left + petX + BTN_RIGHT_EDGE + BTN_W <= fit.vw;
  const btnDx = canRight ? petX + BTN_SIDE_SHIFT : petX;

  return (
    <>
      <div
        ref={rootRef}
        data-pet-hit
        className={[
          "select-none touch-none",
          anchorClass,
          dragging ? "cursor-grabbing" : "cursor-pointer",
        ]
          .filter(Boolean)
          .join(" ")}
        style={pos ? { left: pos.x, top: pos.y } : undefined}
        onPointerDown={handlePointerDown}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        <div className="pd-in relative">
          {/* 气泡：锚点铺满桌宠整块区域（inset-0），Fukidashi 以「桌宠盒子」为基准做
              翻边：上方放不下就翻到下方，且不会压在桌宠身上；靠屏幕边时自动收窄
              静音时只叠透明（muted），不卸载，让打字机与出队照常走 */}
          <AnchoredObservationBubble
            items={queue}
            onDismiss={onDismiss}
            muted={bubblesHidden}
            anchor={<span />}
            anchorClassName="pointer-events-none absolute inset-0"
            placement="top"
          />

          {/* 桌宠本体：与按钮同处一条 transform 曲线（WALK_MS linear），
              两边一起平移，看上去就是「平行移动」。 */}
          <div
            className="relative"
            title="戳一戳 · 长按拖动"
            style={{
              transform: `translateX(${petX}px)`,
              transition: `transform ${WALK_MS}ms linear`,
            }}
          >
            <Pet pet_state={petState} />
          </div>

          {/* 入口按钮：鼠标靠近桌宠区域才浮现（热区见上方 pointermove 效应），
              window / page 两种模式一致。横向位置由 btnDx 的连续 translateX 表达，
              换边时从桌宠身后滑过（DOM 里排在桌宠之前，天然被桌宠遮住，
              所以不需要 z-10；静止态两者恒定留 12px 缝隙，也不会互抢点击）。 */}
          {actions ? (
            <div
              ref={actionsRef}
              data-pet-hit
              className={[
                "absolute right-full top-1/2 mr-3 flex flex-col items-end gap-2",
                actionsOpen
                  ? "pointer-events-auto opacity-100"
                  : "pointer-events-none opacity-0",
              ].join(" ")}
              style={{
                transform: `translate(${btnDx}px, -50%)`,
                transition: `transform ${WALK_MS}ms linear, opacity 200ms`,
              }}
            >
              {actions}
            </div>
          ) : null}
        </div>
      </div>

      {/* 右键菜单：portal 到 body，避免被父级 transform 变成「相对定位」 */}
      {menu
        ? createPortal(
          <>
            <div
              data-pet-hit
              className="fixed inset-0 z-40"
              onPointerDown={() => setMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu(null);
              }}
            />
            <div
              data-pet-hit
              className="fixed z-50 min-w-[176px] overflow-hidden rounded-xl py-1 text-[13px]"
              style={{
                left: menu.x,
                top: menu.y,
                background: "#1b2228",
                border: "1px solid rgba(255,255,255,.14)",
                color: "#e7eef3",
                boxShadow: "0 10px 30px rgba(0,0,0,.45)",
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className="block w-full px-3 py-2 text-left hover:bg-white/10"
                onClick={() => {
                  onToggleBubbles();
                  setMenu(null);
                }}
              >
                {bubblesHidden ? "💬 显示气泡" : "🤫 隐藏气泡"}
              </button>
              {mode === "window" ? (
                <button
                  type="button"
                  className="block w-full px-3 py-2 text-left hover:bg-white/10"
                  onClick={() => {
                    setMenu(null);
                    window.petAPI?.quit();
                  }}
                >
                  🚪 退出桌宠
                </button>
              ) : null}
            </div>
          </>,
          document.body,
        )
        : null}
    </>
  );
}
