"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { PetVisualState } from "@/components/Pet/Pet";
import type {
  BubbleTone,
  ObservationBubbleItem,
} from "@/components/ObservationBubble/ObservationBubble";

/* ==================================================================
   桌宠行为引擎（Step 4 预览用；Step 5 的 usePetState 会在它上面接 B 的真实 Observation）
   ------------------------------------------------------------------
   ① 气泡语气 / 指定状态 → 对应动作：
      push(tone, message, state) 传了 state 就用 B 下发的 pet_state，
      否则退回「语气 → 动作」：normal→OBSERVING / alert→ALERT / discover→EXCITED
      （队首直接派生当前动作，不在 effect 里 setState）
   ② 同一语气配多条台词，每次随机挑一条（预览用假台词，正式版 message 只来自 B）
   ③ 待机时偶尔自己演戏：左右溜达 / 发呆 / 好奇张望 / 整理笔记 / 小声嘀咕
   ④ 观察舱里的人类行为会触发特殊反应（各有冷却，避免刷屏）：
      快速晃动鼠标→警戒 · 鼠标离开观察舱→警戒 · 回来→恢复观察
      长时间不动→记录一笔 · 被戳→重大发现
   ================================================================== */

const TONE_STATE: Record<BubbleTone, PetVisualState> = {
  normal: "OBSERVING",
  alert: "ALERT",
  discover: "EXCITED",
};

/** 队列上限：超过就不再排，避免气泡堆成山 */
const QUEUE_LIMIT = 4;

/** 队列项：在气泡基础上带上「该条要播的 pet_state」（来自 B 的 Observation，Step 5 写入） */
interface QueuedBubble extends ObservationBubbleItem {
  state?: PetVisualState;
  /**
   * 来源：
   * - observation：B 下发的真实观察（Step 5），永不丢弃，队列满时挤掉一条环境气泡
   * - ambient：本机待机小剧场 / 用户行为反应，队列满时直接丢掉
   */
  source: "observation" | "ambient";
}

/* 预览用台词池：同一动作多条文本，随机播放其中一条 */
const POOL: Record<BubbleTone, string[]> = {
  normal: [
    "HUMAN #001 摄入透明液体，本次为今日第 3 次",
    "HUMAN #001 保持同一坐姿超过 40 分钟，疑似进入低功耗",
    "HUMAN #001 反复注视发光板子，专注时长异常",
    "HUMAN #001 发出几个音节，未检测到含义，已归档",
    "HUMAN #001 挠头 2 次，推测正在思考，继续观察",
  ],
  alert: [
    "HUMAN #001 突然离开视野范围，未记录到离场原因",
    "检测到 HUMAN #001 高速位移，已切换追踪模式",
    "HUMAN #001 发出高频声波，来源不明，警戒中",
  ],
  discover: [
    "首次观察到 HUMAN #001 双臂上举后仰，新行为已归档",
    "HUMAN #001 摄入黑色液体后短时效率提升，值得持续观察",
    "HUMAN #001 对着发光板子露出牙齿，疑似威胁展示？",
  ],
};

/* 用户行为 → 触发的语气 / 冷却 / 台词 */
type UserKind = "fast" | "leave" | "return" | "still" | "tap";

const TRIGGER: Record<UserKind, { tone: BubbleTone; cd: number; texts: string[] }> = {
  fast: {
    tone: "alert",
    cd: 9000,
    texts: [
      "检测到 HUMAN #001 高速位移，已切换追踪模式",
      "HUMAN #001 移动速度远超日常记录，警戒中",
    ],
  },
  leave: {
    tone: "alert",
    cd: 8000,
    texts: [
      "HUMAN #001 突然离开视野范围，未记录到离场原因",
      "目标丢失！HUMAN #001 消失在观察窗边缘",
    ],
  },
  return: {
    tone: "normal",
    cd: 6000,
    texts: ["HUMAN #001 回到视野范围，恢复记录"],
  },
  still: {
    tone: "normal",
    cd: 30000,
    texts: [
      "HUMAN #001 已长时间保持静止，疑似进入待机",
      "HUMAN #001 迟迟没有新动作，本研究员先记一笔",
    ],
  },
  tap: {
    tone: "discover",
    cd: 6000,
    texts: [
      "首次记录到 HUMAN #001 主动接触观察舱，重大发现！",
      "HUMAN #001 在敲玻璃！它看得见我？！",
    ],
  },
};

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export function usePetBehavior() {
  /* 待机小剧场的当前状态；有气泡在播时被「队首语气 / B 的 pet_state」派生覆盖 */
  const [actState, setActState] = useState<PetVisualState>("IDLE");
  const [queue, setQueue] = useState<QueuedBubble[]>([]);
  const [petX, setPetX] = useState(0);

  const head = queue[0];

  const seq = useRef(0);
  const queueRef = useRef(queue);
  const walkingRef = useRef(false);
  const xRef = useRef(0);
  const actUntilRef = useRef(0); // 当前小演出占用到何时（此期间不排新演出）
  const actEndRef = useRef<number | null>(null); // 小演出的收尾定时器
  const nextActAtRef = useRef(0); // 下一次待机演出的最早时间
  const coolRef = useRef<Record<string, number>>({});
  const ptrRef = useRef({ x: 0, y: 0, t: 0 });
  const lastMoveAtRef = useRef(0);
  const leaveAtRef = useRef(0);

  /* 队首若有 B 下发的 pet_state 就直接用它，否则按语气派生（渲染期纯计算，不进 effect） */
  const petState: PetVisualState = head
    ? (head.state ?? TONE_STATE[head.tone ?? "normal"])
    : actState;

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    nextActAtRef.current = Date.now() + 2600;
    return () => {
      if (actEndRef.current !== null) window.clearTimeout(actEndRef.current);
    };
  }, []);

  /* 队列从有到空（最后一条播完）→ 稍等一下回到「继续观察」 */
  const queueLen = queue.length;
  const prevLenRef = useRef(0);
  useEffect(() => {
    const prev = prevLenRef.current;
    prevLenRef.current = queueLen;
    if (queueLen > 0 || prev === 0) return;
    const t = window.setTimeout(() => {
      if (Date.now() >= actUntilRef.current) setActState("OBSERVING");
    }, 1200);
    return () => window.clearTimeout(t);
  }, [queueLen]);

  /**
   * 排一条气泡。
   * @param tone  语气，决定气泡配色 / 标签
   * @param message 台词；不传则从预览台词池随机挑一条（正式链路只来自 B 的 message）
   * @param state 该条要播的 pet_state；不传则按语气派生
   * @param source 来源：observation（B 的真实观察，最优先）/ ambient（本机小剧场，可弃）
   */
  const push = useCallback(
    (
      tone: BubbleTone,
      message?: string,
      state?: PetVisualState,
      source: "observation" | "ambient" = "ambient"
    ) => {
      seq.current += 1;
      const item: QueuedBubble = {
        id: seq.current,
        message: message ?? pick(POOL[tone]),
        tone,
        state,
        source,
      };

      setQueue((q) => {
        // B 的真实观察优先级最高：ALERT 插到队首（但不打断已在播的 ALERT）
        if (source === "observation" && state === "ALERT") {
          const headIsAlert = q.length > 0 && q[0].state === "ALERT";
          if (!headIsAlert) return [item, ...q];
        }
        if (q.length < QUEUE_LIMIT) return [...q, item];
        // 队列已满：
        // - ambient（本机闲聊）直接丢弃，避免挤爆队列
        if (source === "ambient") return q;
        // - observation（B 的真实观察）永不丢弃：挤掉一条最旧的 ambient 再入队
        const victim = q.findIndex((it) => it.source === "ambient");
        if (victim === -1) return q;
        const next = q.slice();
        next.splice(victim, 1);
        return [...next, item];
      });
    },
    []
  );

  const dismiss = useCallback((id: number | string) => {
    setQueue((q) => q.filter((it) => it.id !== id));
  }, []);

  const trigger = useCallback(
    (kind: UserKind) => {
      const spec = TRIGGER[kind];
      const now = Date.now();
      if (coolRef.current[kind] > now) return;
      coolRef.current[kind] = now + spec.cd;
      push(spec.tone, pick(spec.texts));
    },
    [push]
  );

  /* 一次待机小演出：占用 ms 毫秒，结束后回到「继续观察」 */
  const playAct = useCallback((state: PetVisualState, ms: number) => {
    setActState(state);
    actUntilRef.current = Date.now() + ms;
    if (actEndRef.current !== null) window.clearTimeout(actEndRef.current);
    actEndRef.current = window.setTimeout(() => {
      actEndRef.current = null;
      setActState("OBSERVING");
    }, ms);
  }, []);

  /* 溜达一段：图集自带 running-right / running-left 行，走路时整体平移 */
  const playWalk = useCallback((dir: 1 | -1) => {
    const ms = rand(1400, 2000);
    let d = dir;
    let target = xRef.current + d * rand(60, 110);
    if (target > 100 || target < -100) {
      d = (d * -1) as 1 | -1;
      target = xRef.current + d * rand(60, 110);
    }
    target = Math.max(-100, Math.min(100, target));
    xRef.current = target;
    setPetX(target);
    setActState(d > 0 ? "WALK_RIGHT" : "WALK_LEFT");
    walkingRef.current = true;
    actUntilRef.current = Date.now() + ms;
    if (actEndRef.current !== null) window.clearTimeout(actEndRef.current);
    actEndRef.current = window.setTimeout(() => {
      actEndRef.current = null;
      walkingRef.current = false;
      setActState("OBSERVING");
    }, ms);
  }, []);

  /* 调度心跳：人类长时间不动 → 记一笔；空闲 → 随机来一段小剧场 */
  useEffect(() => {
    const iv = window.setInterval(() => {
      const now = Date.now();

      if (
        lastMoveAtRef.current > 0 &&
        now - lastMoveAtRef.current > 12000 &&
        queueRef.current.length === 0
      ) {
        lastMoveAtRef.current = now;
        trigger("still");
        return;
      }

      if (now < nextActAtRef.current) return;
      nextActAtRef.current = now + rand(4500, 9000);
      if (queueRef.current.length > 0 || walkingRef.current || now < actUntilRef.current) return;

      const r = Math.random();
      if (r < 0.34) {
        playWalk(Math.random() < 0.5 ? 1 : -1); // 左右溜达
      } else if (r < 0.54) {
        playAct("IDLE", rand(3200, 5200)); // 偶尔发呆
      } else if (r < 0.72) {
        playAct("CURIOUS", rand(2800, 4600)); // 好奇张望
      } else if (r < 0.88) {
        playAct("THINKING", 4600); // 掏出笔记本整理观察记录
      } else {
        push("normal"); // 小声嘀咕一条日常观察
      }
    }, 1200);
    return () => window.clearInterval(iv);
  }, [playAct, playWalk, push, trigger]);

  /* --- 观察舱里的人类行为 --- */
  const onStageMouseMove = useCallback(
    (e: ReactMouseEvent) => {
      const now = performance.now();
      const p = ptrRef.current;
      const dt = now - p.t;
      if (p.t > 0 && dt > 4) {
        const dist = Math.hypot(e.clientX - p.x, e.clientY - p.y);
        if (dist / dt > 2.2) trigger("fast"); // 舱内快速晃动 → 警戒
      }
      ptrRef.current = { x: e.clientX, y: e.clientY, t: now };
      lastMoveAtRef.current = Date.now();
    },
    [trigger]
  );

  const onStageMouseLeave = useCallback(() => {
    leaveAtRef.current = Date.now();
    trigger("leave");
  }, [trigger]);

  const onStageMouseEnter = useCallback(() => {
    const was = leaveAtRef.current;
    leaveAtRef.current = 0;
    if (was > 0 && Date.now() - was > 1500) trigger("return");
  }, [trigger]);

  const onPetClick = useCallback(() => trigger("tap"), [trigger]);

  return {
    petState,
    queue,
    petX,
    push,
    dismiss,
    onPetClick,
    stageProps: {
      onMouseMove: onStageMouseMove,
      onMouseLeave: onStageMouseLeave,
      onMouseEnter: onStageMouseEnter,
    },
  };
}
