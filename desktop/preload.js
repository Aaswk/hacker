// 人类观察站 · 桌面桌宠壳（preload）
//
// 只暴露必要能力给渲染进程，contextIsolation 保持开启。
// 浏览器里 window.petAPI 为 undefined，页面据此判断「是否在桌面壳内」。

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("petAPI", {
  isDesktop: true,
  /**
   * 上报「哪些区域算桌宠」——窗口内 CSS 像素的矩形数组。
   * 主进程据此轮询光标位置决定整窗是否穿透（不再依赖 mousemove 转发）。
   */
  setHitRects(rects) {
    ipcRenderer.send("pet:hit-rects", rects);
  },
  /** 长按拖动桌宠开始 / 结束（窗口已铺满屏，主进程只据此保持可交互） */
  dragStart() {
    ipcRenderer.send("pet:drag-start");
  },
  dragEnd() {
    ipcRenderer.send("pet:drag-end");
  },
  /** 右键菜单「退出桌宠」 */
  quit() {
    ipcRenderer.send("pet:quit");
  },
});
