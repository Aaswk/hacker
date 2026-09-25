"use client";

import { useState } from "react";
import { Pet } from "@/components/Pet/Pet";
import { ObservationBubble } from "@/components/ObservationBubble/ObservationBubble";
import { usePetBehavior } from "@/hooks/usePetBehavior";
import type { PetState } from "@/types/contract";

const STATES: PetState[] = [
  "IDLE",
  "OBSERVING",
  "THINKING",
  "CURIOUS",
  "ALERT",
  "EXCITED",
  "CONFUSED",
];

const LABEL: Record<PetState, string> = {
  IDLE: "发呆",
  OBSERVING: "观察中",
  THINKING: "记录中",
  CURIOUS: "好奇",
  ALERT: "警戒",
  EXCITED: "发现新行为",
  CONFUSED: "困惑",
};

export default function PetPreviewPage() {
  const [state, setState] = useState<PetState>("IDLE");

  /* Step 4：活体桌宠 —— 气泡队列 + 待机小剧场 + 观察舱内用户行为触发 */
  const pet = usePetBehavior();

  return (
    <main className="min-h-screen bg-zinc-900 px-6 py-10 text-zinc-100">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-10">
        <header className="flex flex-col gap-1">
          <h1 className="text-lg font-medium">桌宠状态表演预览</h1>
          <p className="text-xs text-zinc-500">
            Step 3 · 7 个 pet_state 实时动画 ／ Step 4 · 观察气泡 + 待机小剧场 + 用户行为触发
          </p>
        </header>

        {/* Step 4：观察舱。气泡语气驱动动作；没气泡时它自己溜达 / 发呆 / 整理笔记；
            舱里的人类行为（乱晃、离开、发呆、戳它）都会被它记下来 */}
        <section className="flex flex-col items-center gap-5 rounded-xl border border-zinc-800 bg-zinc-950/60 px-6 py-8">
          <div className="flex flex-col items-center gap-1 text-center">
            <h2 className="text-sm font-medium text-zinc-300">
              Step 4 · 观察气泡 + 活体桌宠（react-fukidashi）
            </h2>
            <p className="font-mono text-[10px] text-zinc-600">
              语气驱动动作 · 同一语气多条台词随机播 · 待机偶尔发呆 / 左右溜达 · 舱内人类行为触发警戒
            </p>
          </div>

          <div
            {...pet.stageProps}
            className="relative mx-auto flex w-full max-w-md flex-col gap-3 rounded-2xl border-2 border-dashed border-zinc-700/80 bg-zinc-900/40 px-4 pb-5 pt-3"
          >
            <div className="self-start rounded bg-zinc-800/80 px-2 py-0.5 font-mono text-[10px] tracking-[0.2em] text-zinc-500">
              OBSERVATION CHAMBER · 观察舱
            </div>

            {/* 桌宠本体（可戳）+ 头顶气泡（绝对定位，出现 / 收回都不挤压布局） */}
            <div className="relative flex w-full justify-center">
              <div className="pointer-events-none absolute bottom-full left-1/2 flex -translate-x-1/2 justify-center pb-1">
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

          <div className="flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={() => pet.push("normal")}
              className="rounded-full border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
            >
              普通观察
            </button>
            <button
              type="button"
              onClick={() => pet.push("alert")}
              className="rounded-full border border-orange-700/70 px-3 py-1.5 text-xs text-orange-300 transition-colors hover:border-orange-500 hover:text-orange-100"
            >
              警戒
            </button>
            <button
              type="button"
              onClick={() => pet.push("discover")}
              className="rounded-full border border-amber-600/70 px-3 py-1.5 text-xs text-amber-300 transition-colors hover:border-amber-400 hover:text-amber-100"
            >
              发现
            </button>
            <button
              type="button"
              onClick={() => {
                pet.push("normal");
                pet.push("alert");
                pet.push("discover");
              }}
              className="rounded-full border border-emerald-700/70 px-3 py-1.5 text-xs text-emerald-300 transition-colors hover:border-emerald-400 hover:text-emerald-100"
            >
              连发 3 条（排队）
            </button>
          </div>

          <div className="flex flex-col items-center gap-1 font-mono text-[11px] text-zinc-600">
            <div>
              pet_state = &quot;{pet.petState}&quot; · 队列剩余 {pet.queue.length} 条
            </div>
            <div className="text-zinc-500">
              试试：在舱内快速晃动鼠标 · 把鼠标移出观察舱再回来 · 戳一戳它 · 或者什么都不做
            </div>
          </div>
        </section>

        {/* Step 3 主舞台：点标签切换，动作实时播放 */}
        <section className="flex flex-col items-center gap-6 rounded-xl border border-zinc-800 bg-zinc-950/60 px-6 py-8">
          <div className="w-full max-w-[280px]">
            <Pet pet_state={state} />
          </div>
          <div className="text-center">
            <div className="text-base font-medium">{LABEL[state]}</div>
            <div className="mt-1 font-mono text-xs text-zinc-500">
              pet_state = &quot;{state}&quot;
            </div>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            {STATES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setState(s)}
                aria-pressed={state === s}
                className={
                  "rounded-full border px-3 py-1.5 text-xs transition-colors " +
                  (state === s
                    ? "border-emerald-400 bg-emerald-400/10 text-emerald-200"
                    : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200")
                }
              >
                {LABEL[s]}
              </button>
            ))}
          </div>
        </section>

        {/* 全景：7 个状态同时播放，一眼对比全部动作 */}
        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-medium text-zinc-300">7 个状态同时播放</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {STATES.map((s) => (
              <div
                key={s}
                className="flex flex-col items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-5"
              >
                <div className="w-full max-w-[160px]">
                  <Pet pet_state={s} />
                </div>
                <div className="text-center">
                  <div className="text-xs text-zinc-300">{LABEL[s]}</div>
                  <div className="mt-0.5 font-mono text-[11px] text-zinc-600">{s}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
