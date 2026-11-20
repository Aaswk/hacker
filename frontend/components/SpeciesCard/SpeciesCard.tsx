"use client";

/**
 * Step 7 · 物种卡（Aha Moment）
 * ------------------------------------------------------------------
 * 点击桌宠旁的 🧬 → 先敲键盘（桌宠切 THINKING），再以「game」异形弹窗浮现
 * 一张外星生物学家给 观测体 №001 建的物种档案。
 *
 * 数据全部来自 B 的 GET /species-card：
 *   summary      → 「记录员手记」（原文展示，不改写）
 *   event_counts → 「已记录行为」的 × N 计数（NumberFlow 逐位滚动）
 * 契约字段名一律不改；世界观包装只发生在展示层。
 * 文案口径：记录员冷硬的临床用语，与桌宠萌萌的外表形成反差。
 *
 * 组件：animal-island-ui 的 Modal(variant="game") / Card / Tag / Divider / Button，
 *       计数由 @number-flow/react 承担。
 * 注意：Modal 内部用 createPortal 挂到 document.body，调用方必须 next/dynamic ssr:false。
 * ------------------------------------------------------------------
 */

import "animal-island-ui/style";

import NumberFlow from "@number-flow/react";
import { Button, Card, Divider, Modal, Tag } from "animal-island-ui";
import type { TagColor } from "animal-island-ui";
import { useCallback, useEffect, useState, type CSSProperties } from "react";

import { ApiError, api } from "@/lib/api";
import { HUMAN_EVENTS, type HumanEventType, type SpeciesCard as SpeciesCardData } from "@/types/contract";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const INK = "#725d42";
const INK_SOFT = "#8a7b66";
const FAINT = "#a8987d";

/** 仪式节奏：六段依次落定，前一段稳了再出下一段 */
const STEP = { TITLE: 1, FIELDS: 2, STARS: 3, COUNT: 4, NOTE: 5, SEAL: 6 } as const;

/** [毫秒, 推进到的步骤]，第一拍先归零保证重开也从头演 */
const SCHEDULE: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [160, STEP.TITLE],
  [640, STEP.FIELDS],
  [1080, STEP.STARS],
  [1560, STEP.COUNT],
  [2160, STEP.NOTE],
  [2760, STEP.SEAL],
];

/** event → 展示层世界观归类（只做映射，不改契约）
    口径统一为「记录员笔下的临床用语」：越可爱的动作，命名越冷硬。
    note 是记录员的现场备注，一律 deadpan —— 面不改色地说废话。 */
const BEHAVIOR_LABEL: Record<
  HumanEventType,
  { name: string; emoji: string; tag: TagColor; color: string; note: string }
> = {
  DRINKING: {
    name: "液体摄入",
    emoji: "💧",
    tag: "app-teal",
    color: "#2f9e8f",
    note: "液体补给已记录。记录员也举起了自己的小水杯。",
  },
  STRETCHING: {
    name: "躯体拉伸",
    emoji: "🧘",
    tag: "app-green",
    color: "#3f9d54",
    note: "舒展一下。记录员也抻了抻小爪子。",
  },
  PERSON_LEFT: {
    name: "个体离场",
    emoji: "🚶",
    tag: "app-orange",
    color: "#d4823a",
    note: "暂时离开观察窗。书签已夹好，随时可以回来。",
  },
  PERSON_ENTER: {
    name: "个体入场",
    emoji: "🚪",
    tag: "app-blue",
    color: "#3f7fd4",
    note: "再次进入视野。我们保持不动。",
  },
  PERSON_RETURNED: {
    name: "个体折返",
    emoji: "🔄",
    tag: "app-blue",
    color: "#4a86c9",
    note: "欢迎回来，记录本正翻到上一页。",
  },
  HAND_RAISE: {
    name: "举单手",
    emoji: "✋",
    tag: "app-teal",
    color: "#2f9e8f",
    note: "观测体举起一只手，疑似正在申请发言。",
  },
  ARMS_OUT: {
    name: "双臂平举",
    emoji: "🪽",
    tag: "app-teal",
    color: "#2f9e8f",
    note: "观测体展开双臂，正在测量自身翼展。",
  },
  SMILING: {
    name: "微笑",
    emoji: "🙂",
    tag: "app-teal",
    color: "#2f9e8f",
    note: "观测体嘴角上扬，记录一次微笑。",
  },
  MOUTH_OPEN: {
    name: "持续张嘴",
    emoji: "😮",
    tag: "app-teal",
    color: "#2f9e8f",
    note: "观测体持续张开嘴部，暂未确认用途。",
  },
  PHONE_HELD_LONG: {
    name: "持续手持手机",
    emoji: "📱",
    tag: "app-teal",
    color: "#2f9e8f",
    note: "观测体已持续拿着便携发光板，建议放下手机休息一下。",
  },
  HEAD_TOUCH: {
    name: "摸头／挠头",
    emoji: "🤚",
    tag: "app-teal",
    color: "#2f9e8f",
    note: "观测体把手放到头顶，正在触碰头部。",
  },
  EYE_TOUCH: {
    name: "触碰眼周",
    emoji: "👁️",
    tag: "app-teal",
    color: "#2f9e8f",
    note: "观测体的手靠近眼周，记录一次眼周接触动作。",
  },
  HANDS_TOGETHER: {
    name: "双手合拢",
    emoji: "🙏",
    tag: "app-teal",
    color: "#2f9e8f",
    note: "观测体在身前合拢双手，暂时无法解读这个信号。",
  },
  GLASSES_ON: {
    name: "戴上眼镜",
    emoji: "👓",
    tag: "app-teal",
    color: "#2f9e8f",
    note: "观测体给双眼加装了两片镜片。",
  },
  GLASSES_OFF: {
    name: "摘下眼镜",
    emoji: "👓",
    tag: "app-teal",
    color: "#2f9e8f",
    note: "观测体卸下了眼前的镜片。",
  },
  UNKNOWN: {
    name: "未归类行为",
    emoji: "❔",
    tag: "brown",
    color: "#8a7355",
    note: "我族档案库无对应条目。已上报。",
  },
};

/** 累计次数 → 0~5 颗星，一次观测一颗，封顶五颗 */
function stars(count: number): number {
  if (count <= 0) return 0;
  return Math.min(5, count);
}

export interface SpeciesCardProps {
  open: boolean;
  onClose: () => void;
}

export function SpeciesCard({
  open,
  onClose,
}: SpeciesCardProps) {
  const [step, setStep] = useState(0);
  const [data, setData] = useState<SpeciesCardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  /* ---- 打开即按契约拉一次 GET /species-card ---- */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await api.getSpeciesCard();
          if (cancelled) return;
          setData(res);
          setError(null);
        } catch (err) {
          if (cancelled) return;
          setError(err instanceof ApiError ? err.message : "读取物种卡失败");
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [open]);

  /* ---- 仪式节奏：逐段点亮；关闭时归零，下次重开从头演 ---- */
  useEffect(() => {
    const timers = SCHEDULE.map(([at, s]) => window.setTimeout(() => setStep(s), at));
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [open]);

  const reveal = useCallback(
    (at: number): CSSProperties => {
      const on = step >= at;
      return {
        opacity: on ? 1 : 0,
        transform: on ? "none" : "translateY(6px)",
        transition: "opacity .45s ease, transform .45s ease",
      };
    },
    [step],
  );

  const counts = data?.event_counts ?? {};
  const arrivalStars = stars(
    (counts.PERSON_LEFT ?? 0) + (counts.PERSON_ENTER ?? 0) + (counts.PERSON_RETURNED ?? 0),
  );
  const activityStars = stars(
    (counts.STRETCHING ?? 0) + (counts.PERSON_RETURNED ?? 0) + (counts.PERSON_ENTER ?? 0),
  );
  const hydrationStars = stars(counts.DRINKING ?? 0);

  const behaviors = HUMAN_EVENTS.map((key) => ({
    key,
    count: counts[key] ?? 0,
  })).filter((row) => row.count > 0);

  /* Modal 默认会渲染 header/footer，且 variant="game" 不带关闭按钮，
     这里显式关掉打字机、自备 footer 关闭入口。 */
  return (
    <Modal
      open={open}
      variant="game"
      width={540}
      typewriter={false}
      maskStyle={{ background: "rgba(28,22,14,0.62)" }}
      onClose={onClose}
      footer={
        <div
          style={{
            display: "flex",
            width: "100%",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span style={{ fontSize: 10, letterSpacing: "0.14em", color: FAINT }}>
            异种研究档案库 · 卷宗 {data?.subject_id ?? "HUMAN_001"}
          </span>
          <Button type="primary" onClick={onClose}>
            归档封存
          </Button>
        </div>
      }
    >
      <div style={{ width: "100%", fontSize: 13, lineHeight: 1.6, color: INK_SOFT }}>
        <div
          style={{
            position: "relative",
            display: "flex",
            flexDirection: "column",
            gap: 14,
            // 给右下角的「已归档」印章留出空位，免得压住手记最后一行
            paddingBottom: 34,
          }}
        >
          {/* ---- 抬头 ---- */}
          <div style={reveal(STEP.TITLE)}>
            <div style={{ fontSize: 11, letterSpacing: "0.24em", color: FAINT }}>
              物种档案 · 分类待定
            </div>
            <div
              style={{
                marginTop: 2,
                fontFamily: MONO,
                fontSize: 30,
                fontWeight: 800,
                letterSpacing: "0.04em",
                color: INK,
              }}
            >
              观测体 №001
            </div>
            <div style={{ marginTop: 6, fontSize: 11, color: INK_SOFT }}>
              档案由本次观察记录自动生成
            </div>
          </div>

          {/* ---- 分类字段 ---- */}
          <Card type="dashed" style={{ ...reveal(STEP.FIELDS), padding: "14px 18px" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              <FieldRow label="物种" value="疑似人类（待定）" />
              <FieldRow label="出入记录" stars={arrivalStars} revealAt={STEP.STARS} step={step} />
              <FieldRow
                label="活动记录"
                stars={activityStars}
                revealAt={STEP.STARS}
                step={step}
              />
              <FieldRow
                label="饮水记录"
                stars={hydrationStars}
                revealAt={STEP.STARS}
                step={step}
              />
            </div>
          </Card>

          <Divider type="dashed-brown" style={{ margin: "2px 0" }} />

          {/* ---- 已发现行为（NumberFlow 计数） ---- */}
          <div style={reveal(STEP.COUNT)}>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                marginBottom: 8,
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 800, color: INK }}>已记录行为</span>
              <Tag size="small" variant="soft" color="app-teal">
                已归类 {behaviors.length} 种
              </Tag>
            </div>

            {behaviors.length === 0 ? (
              <p style={{ fontSize: 12, color: FAINT }}>
                暂时还没有行为记录。小本子已经翻开了。
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {behaviors.map(({ key, count }) => {
                  const flavor = BEHAVIOR_LABEL[key];
                  return (
                    <div
                      key={key}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 3,
                        padding: "6px 10px",
                        background: "rgba(255,255,255,0.5)",
                        borderRadius: 12,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 12,
                        }}
                      >
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 15 }}>{flavor.emoji}</span>
                          <span style={{ fontSize: 13, fontWeight: 600, color: INK }}>
                            {flavor.name}
                          </span>
                          <span style={{ fontFamily: MONO, fontSize: 9, color: FAINT }}>{key}</span>
                        </span>
                        <span
                          style={{
                            display: "inline-flex",
                            fontFamily: MONO,
                            fontSize: 15,
                            fontWeight: 800,
                            color: flavor.color,
                          }}
                        >
                          <NumberFlow
                            value={step >= STEP.COUNT ? count : 0}
                            prefix="× "
                            transformTiming={{ duration: 520, easing: "cubic-bezier(.22,.61,.36,1)" }}
                            spinTiming={{ duration: 760 }}
                            opacityTiming={{ duration: 200 }}
                          />
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: FAINT }}>
                        记录员备注：{flavor.note}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <Divider type="squiggle" style={{ margin: "2px 0" }} />

          {/* ---- 记录员手记（B 的 summary 原文） ---- */}
          <div style={reveal(STEP.NOTE)}>
            <div style={{ fontSize: 11, letterSpacing: "0.2em", color: FAINT, marginBottom: 5 }}>
              记录员手记
            </div>
            <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.7, color: INK }}>
              {data?.summary ? data.summary : "这页暂时留白，等新的观察记录来填上。"}
            </p>
            {error ? (
              <p style={{ marginTop: 8, fontSize: 11, color: "#c0392b" }}>
                档案调取失败：{error}
              </p>
            ) : null}
          </div>

          {/* ---- 盖章 ---- */}
          <div
            style={{
              ...reveal(STEP.SEAL),
              position: "absolute",
              right: 4,
              bottom: -10,
              transform: `rotate(-8deg) scale(${step >= STEP.SEAL ? 1 : 0.7})`,
              transition: "opacity .4s ease, transform .45s cubic-bezier(.2,1.5,.4,1)",
              padding: "5px 14px",
              border: "3px double #c0392b",
              borderRadius: 8,
              color: "#c0392b",
              fontSize: 15,
              fontWeight: 800,
              letterSpacing: "0.3em",
              opacity: step >= STEP.SEAL ? 0.86 : 0,
            }}
          >
            已归档
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* 字段行：文字值 或 星级                                                */
/* ------------------------------------------------------------------ */

function FieldRow({
  label,
  value,
  stars: starCount,
  step,
  revealAt,
}: {
  label: string;
  value?: string;
  stars?: number;
  step?: number;
  revealAt?: number;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span
        style={{
          fontSize: 11,
          letterSpacing: "0.16em",
          color: FAINT,
          minWidth: 78,
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      {value !== undefined ? (
        <span style={{ fontSize: 13, fontWeight: 700, color: INK }}>{value}</span>
      ) : (
        <StarRow n={starCount ?? 0} lit={step !== undefined && revealAt !== undefined && step >= revealAt} />
      )}
    </div>
  );
}

function StarRow({ n, lit }: { n: number; lit: boolean }) {
  return (
    <span style={{ display: "inline-flex", gap: 3 }}>
      {Array.from({ length: 5 }, (_, i) => {
        const on = lit && i < n;
        return (
          <span
            key={i}
            style={{
              fontSize: 16,
              lineHeight: 1,
              color: on ? "#e8a72b" : "#d9cbb2",
              transform: on ? "scale(1.12)" : "none",
              transition: "color .32s ease, transform .32s ease",
              transitionDelay: `${i * 110}ms`,
            }}
          >
            {on ? "★" : "☆"}
          </span>
        );
      })}
    </span>
  );
}
