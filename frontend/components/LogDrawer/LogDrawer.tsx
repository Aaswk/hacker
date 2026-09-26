"use client";

/**
 * Step 6 · 观察日志抽屉（LogDrawer）
 * ------------------------------------------------------------------
 * 点击桌宠旁的 📓 → 从屏幕右侧滑出。整块 UI 走世界观包装：
 * 读起来像外星生物学家的田野调查笔记，而不是 AI 识别结果面板。

 *   头 部   XENO RESEARCH DATABASE / HUMAN OBSERVATION LOG
 *           SUBJECT / STATUS / OBSERVATION TIME
 *   行为归类 GET /subjects/HUMAN_001 的 event_counts
 *   时间线   每条 = 时间 · 观察描述 · 当前假说 · 置信度条
 *   数据源   GET /observations（全量，按 observation_id 升序排成时间线）
 *
 * 文案映射：契约只下发 event / message，世界观文案由 A 侧在展示层映射，
 * 不改动任何契约字段名（A 文档 Step 6「可替换点」）。
 * UI 组件来自 animal-island-ui（Drawer / Card / Tag / Progress / Title / Divider）。
 * ------------------------------------------------------------------
 */

import "animal-island-ui/style";

import { Card, Divider, Drawer, Progress, Tag, Title } from "animal-island-ui";
import type { TagColor } from "animal-island-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, api } from "@/lib/api";
import {
  HUMAN_EVENTS,
  type HumanEventType,
  type Observation,
  type SubjectSummary,
} from "@/types/contract";

/* ---- 静默一条第三方已知告警（模块加载即生效）----
   animal-island-ui@1.13.0 的 Drawer 在关闭态给面板传 `inert=""`
   （见 dist/es/components/Drawer/Drawer.js：`e ? {} : { inert: "" }`），
   React 19 会对布尔属性收到空字符串发 warning，并在 dev overlay 里报「1 Issue」。
   该属性由库内部 spread 到面板、且位于其余 props 之后，A 侧无法用 props 覆盖。
   React 在 commit 阶段（甚至早于首次 passive effect）就会发出这条 warning，
   因此拦截必须放在模块作用域，不能放进组件内的 useEffect —— 否则首次渲染
   仍会漏出去。这里只在开发环境精确拦截这一条告警，其余 console.error 原样透传，
   以免掩盖其它真实问题。 */
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    const text = args.map((a) => (typeof a === "string" ? a : "")).join(" ");
    if (text.includes("empty string for a boolean attribute") && text.includes("inert")) {
      return;
    }
    originalError(...args);
  };
}

type ProgressVariant = "sweet-corner" | "forest-grove" | "starry-camp" | "coffee-break";

/** event → 展示层世界观文案（只做映射，不改契约） */
interface EventFlavor {
  /** 行为归类名（累计计数用） */
  category: string;
  emoji: string;
  /** 观察描述（多条候选：同种行为每次记录换一句，避免读起来千篇一律） */
  description: readonly string[];
  /** 当前假说（多条候选：田野笔记的猜测本就该五花八门） */
  hypothesis: readonly string[];
  /** 置信度条场景图，按行为分类换色 */
  progress: ProgressVariant;
  tag: TagColor;
}

const EVENT_FLAVOR: Record<HumanEventType, EventFlavor> = {
  PERSON_ENTER: {
    category: "进入观察区域",
    emoji: "🚪",
    description: [
      "观测体 №001 进入观察区域",
      "观测窗亮起：观测体 №001 回来了",
      "观测体 №001 步入视野，脚步一如既往地随意",
      "档案续写。观测体 №001 已回到镜头范围内",
    ],
    hypothesis: [
      "该生物存在周期性返回固定区域的行为习惯",
      "推测此区域是它的「巢」，离得再远也总要回来",
      "返回时间点疑似与某种内部时钟有关，待验证",
      "也许它只是路过。但每次都路过同一个地方，不太像巧合",
    ],
    progress: "starry-camp",
    tag: "app-blue",
  },
  DRINKING: {
    category: "液体摄入",
    emoji: "💧",
    description: [
      "观测体 №001 摄入透明液体",
      "观测体 №001 举起杯子，透明液体顺利入账",
      "观测到本日又一轮液体补给，动作已相当熟练",
      "观测体 №001 小口补充液体，神情专注，像在完成某种仪式",
    ],
    hypothesis: [
      "人类需要定期补充液体以维持内部系统稳定",
      "液体摄入频率疑似与屏幕亮起时长正相关",
      "该行为更像心理安慰而非生理必需，暂无证据",
      "或许它并不渴。只是需要找个理由把视线移开屏幕",
    ],
    progress: "sweet-corner",
    tag: "app-teal",
  },
  STRETCHING: {
    category: "肢体伸展",
    emoji: "🧘",
    description: [
      "观测体 №001 舒展躯干与上肢",
      "观测体 №001 双臂上举，骨骼发出一连串轻响",
      "观测到一次标准伸展：先向左，再向右，最后长长吐出",
      "观测体 №001 把整个身体折叠后重新展开，疑似重启",
    ],
    hypothesis: [
      "长时间静止后，该生物需要伸展以重置肢体状态",
      "伸展与随后的效率提升疑似相关，值得持续建档",
      "该动作或为某种自我维护程序，周期尚不明确",
      "它可能只是坐累了。这个解释朴素，但本所暂时找不到更好的",
    ],
    progress: "forest-grove",
    tag: "app-green",
  },
  PERSON_LEFT: {
    category: "离开观察区域",
    emoji: "🚶",
    description: [
      "观测体 №001 离开观察区域",
      "目标丢失：观测体 №001 走出观测窗，没有告别",
      "观测体 №001 离场，画面只剩一把空椅子",
      "观测中断。观测体 №001 的去向已超出监测半径",
    ],
    hypothesis: [
      "该生物的移动范围超出当前观察舱，需要扩大监测半径",
      "离场前无任何预兆，本所尚未找到可预测的信号",
      "或与外部刺激有关。可惜本所看不到画面之外",
      "它大概是有事。也可能只是坐不住——两者都符合既有的胡闹记录",
    ],
    progress: "coffee-break",
    tag: "app-orange",
  },
  PERSON_RETURNED: {
    category: "重返观察区域",
    emoji: "🔄",
    description: [
      "观测体 №001 重新出现在观察区域",
      "目标重新上线。观测体 №001 归位，状态看起来和离开时差不多",
      "观测恢复。椅子上的凹陷被 观测体 №001 精准填回",
      "观测体 №001 返回，坐下的姿势与离开前完全一致",
    ],
    hypothesis: [
      "离开与返回行为存在关联，疑似已形成固定动线",
      "返回后的初始状态稳定，说明离场并未改变其基线",
      "该生物对「原位」有执念，位置偏好高于舒适度",
      "它回来了，像是从没走过。本所决定不多问",
    ],
    progress: "starry-camp",
    tag: "app-blue",
  },
  UNKNOWN: {
    category: "未归类行为",
    emoji: "❔",
    description: [
      "观测体 №001 表现出尚未归类的新行为",
      "检测到无法归类的动作，本所的词典里暂时没有对应词条",
      "观测体 №001 做出一个全新的动作，记录笔停顿了半秒",
      "观测到未知行为。已原样归档，等待后续比对",
    ],
    hypothesis: [
      "样本行为库不足，需要更多观察数据才能完成归类",
      "该动作可能是既有行为的变体，也可能两者都不是",
      "暂列「未解」。本所不介意暂时看不懂它",
      "越看越觉得它有它的道理。道理是什么，尚未可知",
    ],
    progress: "coffee-break",
    tag: "brown",
  },
};

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const INK = "#725d42";
const INK_SOFT = "#8a7b66";

/** 新到达的记录高亮多久（ms） */
const HIGHLIGHT_MS = 3600;

function pad2(n: number): string {
  return String(Math.floor(n)).padStart(2, "0");
}

/** ms → 00:17:32 */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${pad2(total / 3600)}:${pad2((total % 3600) / 60)}:${pad2(total % 60)}`;
}

/** ISO → 21:03（本地时间）；解析不了就退化成 #id */
function formatClock(observation: Observation): string {
  if (!observation.timestamp) return `#${observation.observation_id}`;
  const t = Date.parse(observation.timestamp);
  if (Number.isNaN(t)) return `#${observation.observation_id}`;
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 整数散列：把连续的 observation_id 打散，避免相邻记录落到相邻文案上 */
function hashInt(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

/** 按 observation_id 稳定取词：同一条记录每次渲染文案固定，相邻记录自然错开 */
function flavorPick<T>(arr: readonly T[], seed: number): T {
  return arr[hashInt(seed) % arr.length];
}

export interface LogDrawerProps {
  open: boolean;
  onClose: () => void;
  /** GET /observations 的全量列表 */
  observations: Observation[];
  subjectId?: string;
}

export function LogDrawer({
  open,
  onClose,
  observations,
  subjectId = "HUMAN_001",
}: LogDrawerProps) {
  /* ---- OBSERVATION TIME：本次观察会话的累计时长，1s 一跳 ---- */
  const [sessionStart] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  /* ---- GET /subjects/HUMAN_001：累计行为归类 ---- */
  const [subject, setSubject] = useState<SubjectSummary | null>(null);
  const [countError, setCountError] = useState<string | null>(null);

  const loadSubject = useCallback(async () => {
    try {
      setSubject(await api.getSubject(subjectId));
      setCountError(null);
    } catch (err) {
      setCountError(err instanceof ApiError ? err.message : "读取累计数据失败");
    }
  }, [subjectId]);

  useEffect(() => {
    if (!open) return;
    // 抽屉打开时拉一次，之后每来一条新观察再拉一次，计数保持"养成感"
    const t = window.setTimeout(() => void loadSubject(), 0);
    return () => window.clearTimeout(t);
  }, [open, loadSubject, observations.length]);

  /* ---- 时间线：按 observation_id 升序（旧的在上，新的在下） ---- */
  const timeline = useMemo(
    () => [...observations].sort((a, b) => a.observation_id - b.observation_id),
    [observations],
  );
  const newestId = timeline.length > 0 ? timeline[timeline.length - 1].observation_id : null;

  /* ---- 新事件到达：高亮 + 自动滚动到底 ---- */
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const [lastSeenMax, setLastSeenMax] = useState(0);

  useEffect(() => {
    if (newestId === null) return;
    // 首轮只建基线，不把打开前的历史记录当成"新事件"
    if (lastSeenMax === 0) {
      const t = window.setTimeout(() => setLastSeenMax(newestId), 0);
      return () => window.clearTimeout(t);
    }
    if (newestId <= lastSeenMax) return;

    const show = window.setTimeout(() => {
      setLastSeenMax(newestId);
      setHighlightId(newestId);
    }, 0);
    const clear = window.setTimeout(
      () => setHighlightId((cur) => (cur === newestId ? null : cur)),
      HIGHLIGHT_MS,
    );
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(clear);
    };
  }, [newestId, lastSeenMax]);

  const trackRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const el = trackRef.current;
    if (!el) return;
    const t = window.setTimeout(
      () => el.scrollIntoView({ behavior: "smooth", block: "center" }),
      80,
    );
    return () => window.clearTimeout(t);
  }, [open, newestId]);

  /* ---- 累计计数：只展示出现过的行为，按契约枚举顺序 ---- */
  const countRows = HUMAN_EVENTS.map((key) => ({
    key,
    count: subject?.event_counts?.[key] ?? 0,
  })).filter((row) => row.count > 0);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      placement="right"
      width={430}
      title={
        <span style={{ display: "inline-flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontSize: 11, letterSpacing: "0.3em", color: "#a8987d" }}>
            XENO RESEARCH DATABASE
          </span>
          <span style={{ fontSize: 19, fontWeight: 800, color: INK }}>
            HUMAN OBSERVATION LOG
          </span>
        </span>
      }
      footer={
        <span style={{ fontFamily: MONO, fontSize: 11, color: "#a8987d" }}>
          SUBJECT {subjectId} · 累计 {subject?.total_observations ?? 0} 次观察
        </span>
      }
    >
      {/* 抽屉正文基准字号（库内 .animal-body 是 20px，这里压到档案密度） */}
      <div style={{ fontSize: 13, lineHeight: 1.65, color: INK_SOFT }}>
        {/* ---- 档案头 ---- */}
        <Card type="dashed" style={{ padding: "14px 18px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[
              ["SUBJECT", subjectId.replace("_", " #"), INK],
              ["STATUS", "● ACTIVE", "#2e8b57"],
              ["OBSERVATION TIME", formatElapsed(now - sessionStart), INK],
            ].map(([label, value, color]) => (
              <div key={label} style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 10,
                    letterSpacing: "0.16em",
                    color: "#a8987d",
                    minWidth: 132,
                  }}
                >
                  {label}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color }}>
                  {value}
                </span>
              </div>
            ))}
          </div>
        </Card>

        {/* 养成感：观察 → 归类 → 假说 → 档案 */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 6,
            margin: "12px 2px 0",
            fontSize: 11,
            color: "#a8987d",
          }}
        >
          {["观察记录", "行为归类", "形成假说", "更新档案"].map((step, i, all) => (
            <span key={step} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {step}
              {i < all.length - 1 ? <span style={{ color: "#cfc0a4" }}>›</span> : null}
            </span>
          ))}
        </div>

        <Divider type="dashed-brown" style={{ margin: "16px 0 12px" }} />

        {/* ---- 行为归类（累计） ---- */}
        <Title variant="tab" color="app-teal" size="small">
          行为归类
        </Title>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 14 }}>
          {countRows.length === 0 ? (
            <p style={{ fontSize: 12, color: "#a8987d" }}>尚未建立分类样本，继续观察。</p>
          ) : (
            countRows.map(({ key, count }) => {
              const flavor = EVENT_FLAVOR[key];
              return (
                <div
                  key={key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    padding: "6px 10px",
                    background: "rgba(255,255,255,0.45)",
                    borderRadius: 12,
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 15 }}>{flavor.emoji}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: INK }}>
                      {flavor.category}
                    </span>
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: INK }}>
                    × {count}
                  </span>
                </div>
              );
            })
          )}
        </div>
        {countError ? (
          <p style={{ marginTop: 8, fontSize: 11, color: "#c0392b" }}>
            GET /subjects/{subjectId} 失败：{countError}
          </p>
        ) : null}

        <Divider type="squiggle" style={{ margin: "20px 0 12px" }} />

        {/* ---- 观察记录时间线 ---- */}
        <Title variant="tab" color="app-orange" size="small">
          观察记录 {timeline.length}
        </Title>

        {timeline.length === 0 ? (
          <p style={{ marginTop: 14, fontSize: 12, color: "#a8987d" }}>
            档案为空。点击「开始观察」后，这里会逐条累积 观测体 №001 的田野记录。
          </p>
        ) : (
          <ul style={{ marginTop: 14, listStyle: "none", padding: 0 }}>
            {timeline.map((it, i) => {
              const flavor = EVENT_FLAVOR[it.event];
              const desc = flavorPick(flavor.description, it.observation_id);
              const hypo = flavorPick(flavor.hypothesis, it.observation_id);
              const isNewest = it.observation_id === newestId;
              const highlighted = highlightId === it.observation_id;
              const percent = Math.round((it.confidence ?? 0) * 100);
              const last = i === timeline.length - 1;

              return (
                <li
                  key={it.observation_id}
                  ref={isNewest ? trackRef : undefined}
                  style={{ display: "flex", gap: 12 }}
                >
                  {/* 时间轴导轨 */}
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      width: 42,
                      flexShrink: 0,
                    }}
                  >
                    <span style={{ fontFamily: MONO, fontSize: 11, color: "#a8987d" }}>
                      {formatClock(it)}
                    </span>
                    <span
                      style={{
                        width: 9,
                        height: 9,
                        marginTop: 6,
                        borderRadius: "50%",
                        background: highlighted ? "#27d039" : "#d4c4a8",
                        boxShadow: highlighted ? "0 0 0 4px rgba(39,208,57,0.22)" : "none",
                        transition: "all .3s ease",
                      }}
                    />
                    {!last ? (
                      <span
                        style={{
                          flex: 1,
                          width: 2,
                          marginTop: 4,
                          background:
                            "repeating-linear-gradient(#d4c4a8 0 4px, transparent 4px 8px)",
                        }}
                      />
                    ) : null}
                  </div>

                  {/* 记录卡 */}
                  <div style={{ flex: 1, minWidth: 0, paddingBottom: last ? 0 : 16 }}>
                    <Card
                      type="dashed"
                      pattern={highlighted ? "app-green" : "none"}
                      style={{
                        padding: "12px 16px",
                        transition: "all .3s ease",
                        boxShadow: highlighted
                          ? "0 0 0 2px rgba(39,208,57,0.5)"
                          : "0 1px 0 rgba(114,93,66,0.06)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                        }}
                      >
                        <span style={{ fontSize: 14, fontWeight: 700, color: INK }}>
                          {desc}
                        </span>
                        {highlighted ? (
                          <Tag size="small" variant="solid" color={flavor.tag}>
                            新记录
                          </Tag>
                        ) : (
                          <Tag size="small" variant="soft" color={flavor.tag}>
                            {it.event}
                          </Tag>
                        )}
                      </div>

                      <p style={{ marginTop: 6, fontSize: 12.5, color: INK_SOFT }}>
                        当前假说：{hypo}
                      </p>

                      {/* B 下发的原文，作为"现场记录"保留，不做改写 */}
                      <p
                        style={{
                          marginTop: 6,
                          fontSize: 11.5,
                          fontStyle: "italic",
                          color: "#a8987d",
                        }}
                      >
                        现场记录：“{it.message}”
                      </p>

                      <div style={{ marginTop: 10 }}>
                        <div
                          style={{
                            fontFamily: MONO,
                            fontSize: 10,
                            letterSpacing: "0.16em",
                            color: "#a8987d",
                            marginBottom: 5,
                          }}
                        >
                          置信度
                        </div>
                        <Progress
                          percent={percent}
                          size="small"
                          variant={flavor.progress}
                          duration={0.8}
                          aria-label={`${desc} 的置信度`}
                        />
                      </div>
                    </Card>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Drawer>
  );
}
