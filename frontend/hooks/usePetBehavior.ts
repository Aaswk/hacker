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
   ③ 待机时偶尔自己演戏：左右溜达 / 发呆 / 好奇张望 / 整理笔记 / 无事闲聊 /
      外星趣事 / 自说自话（思索、打量陈设、RP 自己的居住环境）
   ④ 观察舱里的人类行为会触发特殊反应（各有冷却，避免刷屏）：
      快速晃动鼠标→警戒 · 鼠标离开观察舱→警戒 · 回来→恢复观察
      长时间不动→记录一笔 · 被戳→重大发现
   ⑤ 主动检测：到点按本场行为计数外推一条结论（先本地模拟，待接 C 的动作识别）
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

/* 预览用台词池：同一动作多条文本，随机播放其中一条。
   刻意混搭多种文风：冷淡田野记录 / 冷幽默吐槽 / 警报播报 / 档案公文，
   让同样的行为每次反馈都不太一样。 */
const POOL: Record<BubbleTone, string[]> = {
  normal: [
    "观测体 №001 摄入透明液体，本次为今日第 3 次",
    "观测体 №001 保持同一坐姿超过 40 分钟，疑似进入低功耗",
    "观测体 №001 反复注视发光板子，专注时长异常",
    "观测体 №001 发出几个音节，未检测到含义，已归档",
    "观测体 №001 挠头 2 次，推测正在思考，继续观察",
    "观测体 №001 对着发光板子叹气，叹息成分待化验",
    "观测体 №001 左右张望 4 次，附近并没有值得张望的东西",
    "观测体 №001 揉了揉眼睛，随后继续注视发光板子。恒心可嘉",
    "检测到 观测体 №001 的坐姿已从「端正」降级为「融化」",
    "观测体 №001 打了一个哈欠，嘴部张合幅度创本日新高",
    "观测体 №001 似乎在低声与发光板子争执，板子拒不回应",
    "观测体 №001 伸手够向桌角，动作熟练，疑似日常仪式",
    "观测体 №001 的视线在屏幕与本子之间来回搬运，效率未知",
    "记录：观测体 №001 又一次对自己说了句「马上就好」",
  ],
  alert: [
    "观测体 №001 突然离开视野范围，未记录到离场原因",
    "检测到 观测体 №001 高速位移，已切换追踪模式",
    "观测体 №001 发出高频声波，来源不明，警戒中",
    "观测体 №001 起身速度异常，请全体研究员扶稳记录本",
    "警报：观测体 №001 的手伸向了不该伸向的地方",
    "观测体 №001 位置突变，本次移动未提交任何申请",
    "监测到 观测体 №001 大幅后仰，椅子发出了求救信号",
    "观测体 №001 猛地回头，与本观察舱对视 0.4 秒，随后装作无事发生",
  ],
  discover: [
    "首次观察到 观测体 №001 双臂上举后仰，新行为已归档",
    "观测体 №001 摄入黑色液体后短时效率提升，值得持续观察",
    "观测体 №001 对着发光板子露出牙齿，疑似威胁展示？",
    "重大发现：观测体 №001 竟能一边发呆一边打字，本所暂无解释",
    "首次记录到 观测体 №001 对空气点头，回应对象不明",
    "观测体 №001 突然无声发笑，笑点不在监控范围内",
    "新行为归档：观测体 №001 把两件事同时忘掉，又同时想起",
    "检测到 观测体 №001 的自我辩解行为，逻辑自洽度约 61%",
  ],
};

/* 待机时「丰富文本」三个池子（都走 normal 语气，不冒充实况观察）：
   - CHAT  无事闲聊：观察员自己的日常，符合「异星研究员驻守观察舱」的设定
   - ALIEN 外星趣事：本星见闻 / 本所同事的八卦，用来撑住角色背景
   - MUTTER 自说自话：思索、打量舱内陈设、RP 自己的居住环境
   实况观察（B 的 message）走 POOL / TRIGGER，与这三池分开，避免混淆真假。 */
const CHAT = [
  "记录一下：本研究员今天也按时上班了，虽然并没有人监督",
  "顺便一提，本所的咖啡机又坏了。不影响观察工作，只影响心情",
  "今天的日志上我写下「一切正常」，这是最省事也最准确的一句",
  "有点饿了。外星人也会饿，只是我们的饿不写在脸上",
  "观察舱的窗外没什么可看的，但我还是会看。习惯跨物种通用",
  "数了数今天的记录条目，比我预想的多。人类真是费笔",
  "安静的时候我会听舱里的通风声，它比人类的对话好懂",
  "本所规定每两小时休息一次。我一直遵守，毕竟规定是我写的",
];

const ALIEN = [
  "分享一则本星见闻：我们那边的水往上流，所以没人学过游泳",
  "本星趣闻：我们打招呼是互相看一眼就走，人类似乎不太适应",
  "我们星球的小孩不学写字，只学「怎么安静地待着」，据说我考了满分",
  "本星有个节日叫「不回应节」，那天谁都不许回答任何问题。人类听了很羡慕",
  "我们那边的天空是绿的。第一次见到人类的蓝天时，我以为屏幕坏了",
  "本所同期还有研究员在观察「猫」，进度比我快，因为它根本不动",
  "我们星球的成年人睡前会数今天撒了几个谎。我一般是零，因为我很少说话",
  "本星的门都不上锁，因为没人想进去。人类的门都锁着，这点我研究很久了",
];

const MUTTER = [
  "（思索）……如果把「发呆」也算一种行为，观测体 №001 今天的成就相当可观",
  "（思索）我总觉得观察这件事，看得越久越不明白。但记录还是要记的",
  "（打量陈设）舱里这张桌子的左边角磨损严重，说明人类也常坐这一侧",
  "（打量陈设）记录本快写完了，页脚卷了起来，和上上次一样",
  "（打量陈设）观察舱的灯有点闪。我调了三次，它还是闪。算了",
  "（环顾居所）我住的地方不大：一张记录台、一把椅子、一扇朝人类的窗。够用",
  "（环顾居所）舱壁上贴着历年的观察日志，最早那几页字还很潦草",
  "（自言自语）今天的通风声比昨天低半度，只有我听得出来",
  "（自言自语）如果有一天 观测体 №001 不来了，我就把今天的记录再读一遍",
  "（收拾桌面）把记录笔摆正，第四次。桌面齐的时候，思路也齐一点",
];

/* 用户行为 → 触发的语气 / 冷却 / 台词 */
type UserKind = "fast" | "leave" | "return" | "still" | "tap";

const TRIGGER: Record<UserKind, { tone: BubbleTone; cd: number; texts: string[] }> = {
  fast: {
    tone: "alert",
    cd: 9000,
    texts: [
      "检测到 观测体 №001 高速位移，已切换追踪模式",
      "观测体 №001 移动速度远超日常记录，警戒中",
      "警告：观察舱内出现不明高速物体，疑似人类手臂",
      "观测体 №001 的运动轨迹无法预测，建议保持距离",
      "目标剧烈移动，本所的镜头追得很辛苦",
      "检测到突发位移，已默默把记录笔握紧了",
    ],
  },
  leave: {
    tone: "alert",
    cd: 8000,
    texts: [
      "观测体 №001 突然离开视野范围，未记录到离场原因",
      "目标丢失！观测体 №001 消失在观察窗边缘",
      "观测窗空了。没有告别，没有解释",
      "观测体 №001 撤离迅速，疑似有要事，也可能只是想走",
      "信号中断：观测体 №001 已不在监测半径内",
    ],
  },
  return: {
    tone: "normal",
    cd: 6000,
    texts: [
      "观测体 №001 回到视野范围，恢复记录",
      "目标重新上线，看起来和离开时一样",
      "观测体 №001 归位，本所松了一口气并假装没松",
      "观察对象返回，档案继续，笔尖继续",
    ],
  },
  still: {
    tone: "normal",
    cd: 30000,
    texts: [
      "观测体 №001 已长时间保持静止，疑似进入待机",
      "观测体 №001 迟迟没有新动作，本研究员先记一笔",
      "静止时长刷新纪录，暂无证据表明它已睡着",
      "观测体 №001 一动不动，本所开始怀疑是不是卡住了",
      "长时间无动作。已归档为「冥想」，虽然并无依据",
    ],
  },
  tap: {
    tone: "discover",
    cd: 6000,
    texts: [
      "首次记录到 观测体 №001 主动接触观察舱，重大发现！",
      "观测体 №001 在敲玻璃！它看得见我？！",
      "检测到观察舱受到触碰，来源：观测体 №001。挑衅还是打招呼？",
      "观测体 №001 主动发起接触，本所首次成为被观察的一方",
      "接触事件！已回放三遍，仍未确定它的意图",
    ],
  },
};

/* 每条池子记住最近用过的下标，随机时尽量避开，避免同样行为反复播同一句。
   用「池子 → 最近下标」的模块级 Map，跨调用共享；只保留最近 KEEP 条。 */
const KEEP_RECENT = 5;
const recentIdx = new Map<string, number[]>();

function pickFresh<T>(key: string, arr: readonly T[]): T {
  if (arr.length <= 1) return arr[0];
  let used = recentIdx.get(key);
  if (!used) {
    used = [];
    recentIdx.set(key, used);
  }
  const keep = Math.min(KEEP_RECENT, arr.length - 1);
  let idx = Math.floor(Math.random() * arr.length);
  for (let n = 0; n < 10 && used.includes(idx); n++) {
    idx = Math.floor(Math.random() * arr.length);
  }
  used.push(idx);
  while (used.length > keep) used.shift();
  return arr[idx];
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/* ------------------------------------------------------------------
   本场会话统计 + 「主动检测」延伸分析
   ------------------------------------------------------------------
   主动检测尚未接入 C 的动作识别（端口 8002）。这里先用本机能统计到的
   行为计数（在场时长 / 主动接触 / 高速位移 / 离席）模拟几类检测结论，
   措辞保持「田野记录 + 数据外推」的调性，避免像真的医疗建议。
   等 C 的动作识别就绪，把 analysisLines 换成 B/C 下发的观测即可。
   ------------------------------------------------------------------ */
interface SessionStats {
  startedAt: number;
  /** 最近一次人类活动（鼠标移动）的时间戳；0 = 尚未记录到 */
  lastMoveAt: number;
  /** 主动接触观察舱（戳桌宠）次数 */
  taps: number;
  /** 高速位移次数 */
  fasts: number;
  /** 离席次数 */
  leaves: number;
}

interface AnalysisLine {
  tone: BubbleTone;
  text: string;
}

function analysisLines(s: SessionStats, now: number): AnalysisLine[] {
  const mins = Math.max(1, Math.floor((now - (s.startedAt || now)) / 60000));
  const idleMins = s.lastMoveAt > 0 ? Math.max(0, Math.floor((now - s.lastMoveAt) / 60000)) : 0;
  return [
    {
      tone: "normal",
      text: `延伸分析：本场观察已进行 ${mins} 分钟，观测体 №001 主动接触 ${s.taps} 次，互动意愿指数 +${Math.min(90, s.taps * 7)}%`,
    },
    {
      tone: "alert",
      text: `久坐预警：观测体 №001 已连续静止 ${idleMins} 分钟，痔疮风险较基准上涨 ${(idleMins * 0.05).toFixed(2)}%`,
    },
    {
      tone: "alert",
      text: `长时静默：静止累计 ${idleMins} 分钟，颈椎与手腕的磨损率同步上涨 ${(idleMins * 0.03).toFixed(2)}%`,
    },
    {
      tone: "normal",
      text: `延伸分析：本场记录到 ${s.fasts} 次高速位移，推算 观测体 №001 今日代谢水平偏高 ${Math.min(40, s.fasts * 6)}%`,
    },
    {
      tone: "normal",
      text: `延伸分析：本场离席 ${s.leaves} 次，平均专注周期约 ${Math.max(1, Math.floor(mins / Math.max(1, s.leaves + 1)))} 分钟`,
    },
    {
      tone: "discover",
      text: `趋势推测：按当前接触频率，观测体 №001 对本观察舱的信任度约 ${Math.min(99, 30 + s.taps * 9)}%，建议继续投喂好奇心`,
    },
  ];
}

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
  const nextScanAtRef = useRef(0); // 下一次「主动检测」的最早时间
  const coolRef = useRef<Record<string, number>>({});
  const ptrRef = useRef({ x: 0, y: 0, t: 0 });
  const leaveAtRef = useRef(0);
  /** 本场会话统计（在场时长 / 主动接触 / 高速位移 / 离席），供主动检测外推 */
  const statsRef = useRef<SessionStats>({
    startedAt: 0,
    lastMoveAt: 0,
    taps: 0,
    fasts: 0,
    leaves: 0,
  });

  /* 队首若有 B 下发的 pet_state 就直接用它，否则按语气派生（渲染期纯计算，不进 effect） */
  const petState: PetVisualState = head
    ? (head.state ?? TONE_STATE[head.tone ?? "normal"])
    : actState;

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    statsRef.current.startedAt = Date.now();
    nextActAtRef.current = Date.now() + 9000;
    nextScanAtRef.current = Date.now() + rand(70000, 100000); // 首次主动检测约 1.5 分钟后
    return () => {
      if (actEndRef.current !== null) window.clearTimeout(actEndRef.current);
    };
  }, []);

  /* 人类活动监测：鼠标一动即视为「在场」。
     用全局 pointermove 而不是 stageProps，这样 Electron /pet（不挂 stageProps）也能统计 */
  useEffect(() => {
    const onMove = () => {
      statsRef.current.lastMoveAt = Date.now();
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
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
        message: message ?? pickFresh("pool:" + tone, POOL[tone]),
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

  /** 触发一类用户行为反应；返回是否真的触发（冷却中为 false） */
  const trigger = useCallback(
    (kind: UserKind) => {
      const spec = TRIGGER[kind];
      const now = Date.now();
      if (coolRef.current[kind] > now) return false;
      coolRef.current[kind] = now + spec.cd;
      // 顺带记账，供「主动检测」做延伸分析
      if (kind === "tap") statsRef.current.taps += 1;
      else if (kind === "fast") statsRef.current.fasts += 1;
      else if (kind === "leave") statsRef.current.leaves += 1;
      push(spec.tone, pickFresh("trg:" + kind, spec.texts));
      return true;
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
      setActState("IDLE");
    }, ms);
  }, []);

  /* 溜达一段：图集自带 running-right / running-left 行，走路时整体平移 */
  const playWalk = useCallback((dir: 1 | -1) => {
    // 溜达余量围绕锚点对称展开，锚点是「水平居中」的桌宠盒子（宽 200），
    // 所以左右各能走的距离 = 视口半宽 − 盒子半宽 − 一点余量。
    // 取「视口宽三成」与这个上限的较小值：宽屏下按三成走得开，
    // 窄屏（小笔记本 / 竖屏）下也不会走到屏外只剩半个身子。
    const span =
      typeof window === "undefined"
        ? 100
        : Math.max(
          40,
          Math.min(
            Math.round(window.innerWidth * 0.3),
            Math.round(window.innerWidth / 2 - 108),
          ),
        );
    const ms = rand(1400, 2000);
    let d = dir;
    let target = xRef.current + d * rand(60, 110);
    if (target > span || target < -span) {
      d = (d * -1) as 1 | -1;
      target = xRef.current + d * rand(60, 110);
    }
    target = Math.max(-span, Math.min(span, target));
    xRef.current = target;
    setPetX(target);
    setActState(d > 0 ? "WALK_RIGHT" : "WALK_LEFT");
    walkingRef.current = true;
    actUntilRef.current = Date.now() + ms;
    if (actEndRef.current !== null) window.clearTimeout(actEndRef.current);
    actEndRef.current = window.setTimeout(() => {
      actEndRef.current = null;
      walkingRef.current = false;
      setActState("IDLE");
    }, ms);
  }, []);

  /* 调度心跳：人类长时间不动 → 记一笔；到点 → 主动检测；空闲 → 随机来一段小剧场 */
  useEffect(() => {
    const iv = window.setInterval(() => {
      const now = Date.now();

      if (
        statsRef.current.lastMoveAt > 0 &&
        now - statsRef.current.lastMoveAt > 45000 &&
        queueRef.current.length === 0
      ) {
        statsRef.current.lastMoveAt = now;
        trigger("still");
        return;
      }

      const idle =
        queueRef.current.length > 0 || walkingRef.current || now < actUntilRef.current;

      /* 主动检测：本地模拟（尚未接 C 的动作识别）——按本场行为计数外推一条结论。
         只在桌宠空闲且队列空时播，避免和实况观察挤在一起 */
      if (!idle && now >= nextScanAtRef.current) {
        nextScanAtRef.current = now + rand(120000, 200000);
        const line = pickFresh("scan:analysis", analysisLines(statsRef.current, now));
        push(line.tone, line.text);
        return;
      }

      if (now < nextActAtRef.current) return;
      nextActAtRef.current = now + rand(11000, 22000);
      if (idle) return;

      const r = Math.random();
      if (r < 0.16) {
        playWalk(Math.random() < 0.5 ? 1 : -1); // 偶尔溜达
      } else if (r < 0.74) {
        playAct("IDLE", rand(3200, 5200)); // 发呆（大部分时间）
      } else if (r < 0.84) {
        playAct("CURIOUS", rand(2800, 4600)); // 好奇张望
      } else if (r < 0.90) {
        playAct("THINKING", 4600); // 掏出笔记本整理观察记录
      } else if (r < 0.94) {
        push("normal", pickFresh("chat", CHAT)); // 无事闲聊
      } else if (r < 0.97) {
        push("normal", pickFresh("alien", ALIEN)); // 外星趣事分享
      } else {
        push("normal", pickFresh("mutter", MUTTER)); // 自说自话
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
