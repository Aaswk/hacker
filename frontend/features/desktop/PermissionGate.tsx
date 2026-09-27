"use client";

import { useSyncExternalStore } from "react";

import { Button, Card } from "animal-island-ui";
import "animal-island-ui/style";

import type { CameraFailureReason, CameraStatus } from "@/hooks/useCamera";

/* ==================================================================
   首次进入的授权卡（Step 8）
   ------------------------------------------------------------------
   进入体验只承担一件事：授权摄像头。这里不跳页、不讲技术名词，
   用一张小卡片把「请求摄像头权限」说成「我需要借用你的眼睛」，
   按钮沿用 animal-island-ui 的 pill 形状（自带「Q弹」按压反馈）。
   ------------------------------------------------------------------
   动画：卡片像小饼干一样「啵」地弹出（弹性缓动 + 轻微过冲）。
   居中一律用 flex，绝不在同一元素上混用 Tailwind translate 与 keyframes。
   ================================================================== */

const GATE_CSS = `
@keyframes gate-pop {
  0%   { opacity: 0; transform: translateY(22px) scale(.86); }
  62%  { opacity: 1; transform: translateY(-6px) scale(1.03); }
  100% { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes gate-drop {
  0%   { opacity: 0; transform: translateY(30px) scale(.9) rotate(-6deg); }
  100% { opacity: 1; transform: translateY(0) scale(1) rotate(-3deg); }
}
@keyframes gate-drop-r {
  0%   { opacity: 0; transform: translateY(30px) scale(.9) rotate(6deg); }
  100% { opacity: 1; transform: translateY(0) scale(1) rotate(3deg); }
}
.gate-card { animation: gate-pop 620ms cubic-bezier(.22,1.4,.36,1) both; }
.gate-back-l { animation: gate-drop 700ms cubic-bezier(.22,1.3,.36,1) 40ms both; }
.gate-back-r { animation: gate-drop-r 700ms cubic-bezier(.22,1.3,.36,1) 120ms both; }
@media (prefers-reduced-motion: reduce) {
  .gate-card, .gate-back-l, .gate-back-r { animation: none; }
}
`;

/* 安全上下文探测：`isSecureContext` / `mediaDevices` 属于「React 之外的环境状态」，
   用 useSyncExternalStore 订阅（服务端快照固定 false）——既不会触发 hydration 不一致，
   也避免在 effect 里同步 setState（对齐 components/Pet/Pet.tsx 里 reduced-motion 的写法）。 */
function subscribeSecureContext() {
  /* 安全上下文不会在页面生命周期里改变，无需真正监听，返回空退订即可 */
  return () => {};
}

function getInsecureEnv() {
  return (
    !window.isSecureContext && !window.navigator.mediaDevices?.getUserMedia
  );
}

export interface PermissionGateProps {
  status: CameraStatus;
  error: string | null;
  /** 失败细分原因：`insecure-context` 时换成「不是设备的问题」那套话术 */
  reason?: CameraFailureReason | null;
  onStart: () => void;
  /** 「暂时不授权，先看看」：跳过授权，也让桌宠先登场 */
  onSkip: () => void;
}

export function PermissionGate({
  status,
  error,
  reason = null,
  onStart,
  onSkip,
}: PermissionGateProps) {
  const busy = status === "loading";
  const failed = status === "denied" || status === "unavailable" || status === "error";
  /* 手机 + http:// 局域网地址：iOS 直接不提供摄像头 API。这不是「没插摄像头」，
     是浏览器的安全上下文限制，所以文案和按钮都要换一套（见 README 6.6 节「坑 2」）。
     提前探测（而不是等用户点「开始体验」）才能让手机一进来就看见实话。 */
  const insecureEnv = useSyncExternalStore(subscribeSecureContext, getInsecureEnv, () => false);
  const insecure = reason === "insecure-context" || insecureEnv;

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center px-6">
      <style>{GATE_CSS}</style>

      <div className="relative w-full max-w-[420px]">
        {/* 背景两张低透明度装饰卡，做出「堆叠式弹窗」的层次感 */}
        <div
          className="gate-back-l absolute inset-x-6 -top-3 h-full rounded-[28px]"
          style={{ background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.08)" }}
        />
        <div
          className="gate-back-r absolute inset-x-3 -top-1.5 h-full rounded-[28px]"
          style={{ background: "rgba(255,255,255,.09)", border: "1px solid rgba(255,255,255,.1)" }}
        />

        <div className="gate-card relative">
          <Card pattern="app-teal" style={{ padding: "26px 24px 22px", borderRadius: 28 }}>
            <div className="flex flex-col items-center gap-3 text-center">
              <span
                className="rounded-full px-3 py-1 text-[11px] tracking-[0.18em]"
                style={{ background: "rgba(0,0,0,.28)", color: "#eaf7f4" }}
              >
                权限请求 · 01
              </span>

              <h1
                className="text-[20px] font-semibold leading-snug"
                style={{ color: "#1f2a30" }}
              >
                👽 我需要借用你的眼睛来观察人类
              </h1>

              {insecure ? (
                <p className="text-[13px] leading-relaxed" style={{ color: "#3b4a52" }}>
                  <b>这台设备暂时用不了摄像头</b>——但桌宠和观察数据照常刷新。
                  <br />
                  想开摄像头？看下面的说明。
                </p>
              ) : (
                <p className="text-[13px] leading-relaxed" style={{ color: "#3b4a52" }}>
                  打开摄像头，我才能看见你在做什么。
                  <br />
                  画面只用在这一台设备上，不会上传、不会保存。
                </p>
              )}

              {status === "denied" && (
                <ol
                  className="w-full list-decimal space-y-1 rounded-2xl px-5 py-3 text-left text-[12px]"
                  style={{ background: "rgba(255,255,255,.5)", color: "#3b4a52" }}
                >
                  <li>点击地址栏左侧的锁 / 摄像头图标</li>
                  <li>把「摄像头」改为「允许」</li>
                  <li>刷新页面，或点下方按钮重试</li>
                </ol>
              )}

              {(status === "unavailable" || (insecure && status === "idle")) &&
                (insecure ? (
                  <div
                    className="w-full space-y-1 rounded-2xl px-4 py-3 text-left text-[12px] leading-relaxed"
                    style={{ background: "rgba(255,255,255,.5)", color: "#3b4a52" }}
                  >
                    <p className="font-semibold" style={{ color: "#1f2a30" }}>
                      不是设备的问题：浏览器不开放摄像头
                    </p>
                    <p>
                      iPhone / iPad 只在 <b>HTTPS</b> 或 <b>localhost</b> 下才给摄像头，
                      现在是用 <code>http://</code> 局域网地址打开的，所以摄像头 API 被直接藏了。
                    </p>
                    <p>
                      不影响看数据：点下面「不用摄像头，直接继续」，桌宠和观察记录照常刷新；
                      只想看观察面板也可以直接开 <b>/live</b>。
                    </p>
                  </div>
                ) : (
                  <p className="text-[12px]" style={{ color: "#5b6b73" }}>
                    没找到可用的摄像头：请确认设备已连接、未被其他程序占用，
                    且页面运行在 localhost 或 HTTPS 下。
                  </p>
                ))}

              {status === "error" && error && (
                <p className="text-[12px]" style={{ color: "#a3502f" }}>
                  {error}
                </p>
              )}

              <div className="mt-1 flex flex-col items-center gap-2">
                {insecure ? (
                  <>
                    <Button type="primary" size="middle" onClick={onSkip}>
                      不用摄像头，直接继续
                    </Button>
                    <Button type="text" size="small" loading={busy} onClick={onStart}>
                      再试一次授权
                    </Button>
                    <a
                      href="/live"
                      className="text-[12px] underline underline-offset-4"
                      style={{ color: "#3b4a52" }}
                    >
                      只想看观察面板 → 打开 /live
                    </a>
                  </>
                ) : (
                  <>
                    <Button type="primary" size="middle" loading={busy} onClick={onStart}>
                      {busy ? "正在请求…" : failed ? "重新授权" : "开始体验"}
                    </Button>
                    <Button type="text" size="small" onClick={onSkip}>
                      暂时不授权，先看看
                    </Button>
                  </>
                )}
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
