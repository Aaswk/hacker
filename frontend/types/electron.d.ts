// 桌面壳（Electron preload）暴露给渲染进程的能力。
// 浏览器里 window.petAPI 为 undefined，页面据此判断「是否在桌面壳内」。

export { };

/** 命中区域：窗口内 CSS 像素的矩形（加窗口屏幕坐标即屏幕矩形） */
export interface PetHitRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

declare global {
  interface PetDesktopAPI {
    /** 恒为 true；存在即代表跑在 Electron 壳里 */
    isDesktop: boolean;
    /** 上报「哪些区域算桌宠」；主进程据此轮询光标决定整窗是否穿透 */
    setHitRects(rects: PetHitRect[]): void;
    /** 长按拖动开始 / 结束（主进程轮询屏幕坐标移窗） */
    dragStart(): void;
    dragEnd(): void;
    /** 右键菜单「退出桌宠」 */
    quit(): void;
  }

  interface Window {
    petAPI?: PetDesktopAPI;
  }
}
