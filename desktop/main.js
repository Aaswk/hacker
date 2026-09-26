// 人类观察站 · 桌面桌宠壳（Electron 主进程）
//
// 职责：
//  - 开一个「透明 / 无边框 / 置顶 / 不进任务栏」的窗口，加载 Next 的 /pet 路由。
//    窗口铺满所在显示器的工作区（不含任务栏），也就是「边缘刚好贴着屏幕边」——
//    桌面整块都是桌宠的舞台，所以拖动不再是移窗，而是桌宠自己在整屏内移动
//    （由渲染进程的 PetDock 负责，主进程只标记「拖动中，别穿透」）。
//  - 跨平台 / 跨屏幕自适应（不写死任何分辨率）：
//      尺寸一律取 workArea —— Windows/Linux 不含任务栏，macOS 不含菜单栏与 Dock，
//      所以「贴着屏幕边」在每台机器上都是贴着可用的那块桌面。
//      启动时打印一次检测到的显示器清单（尺寸 / 缩放 / 工作区），
//      插拔显示器、改分辨率、改缩放、隐藏任务栏时自动重新铺满；
//      Electron 的窗口坐标 / CSS 像素都走 DIP，Retina 等高缩放下命中判定不用换算。
//      macOS 额外声明「出现在所有桌面 / 全屏应用之上」并隐藏 Dock 图标；
//      Linux 需要合成器（compositor）才支持透明窗，无合成器时会是一块黑底。
//  - 默认让整窗鼠标穿透（transparent 区域不挡桌面点击）；
//    命中判定由主进程做：渲染进程上报桌宠 / 按钮 / 弹层面板的窗口内矩形，
//    主进程每 HIT_INTERVAL_MS 读一次光标屏幕坐标，落在矩形内才关穿透。
//    ——不再依赖 setIgnoreMouseEvents(forward:true) 是否把 mousemove 送到渲染进程，
//      那条链路一旦断掉就会出现「看得见、碰不到、拖不动」的幽灵窗口。
//  - 兜底：渲染进程崩溃 / 卡死自动重载；全局快捷键可强制重载或退出
//
// 启动：
//   cd hacker/desktop && npm install && npm run pet
//   （PET_URL 可覆盖加载地址，默认 http://localhost:3000/pet）

const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require("electron");

/** 命中判定轮询间隔 */
const HIT_INTERVAL_MS = 24;
/** 命中判定外扩（DIP），给桌宠一点宽容边 */
const HIT_PAD = 6;
/** 自愈重载的最小间隔，避免崩溃时反复 reload */
const RELOAD_COOLDOWN_MS = 10000;

const PET_URL = process.env.PET_URL || "http://localhost:3000/pet";

const IS_MAC = process.platform === "darwin";
/** 显示器变化后重排窗口的防抖时长（插拔 / 改分辨率会连发多次事件） */
const REFIT_DEBOUNCE_MS = 250;

/** @type {BrowserWindow | null} */
let win = null;
/** @type {NodeJS.Timeout | null} */
let hitTimer = null;
/** @type {NodeJS.Timeout | null} */
let refitTimer = null;
/** 渲染进程上报的命中区域（窗口内 CSS 像素）；与窗口 bounds 相加即屏幕坐标 */
let hitRects = [];
/** 当前是否整窗穿透；null = 尚未向系统设置过 */
let ignoring = null;
/** 是否正在「长按拖动桌宠」：拖动期间保持可交互，指针甩出桌宠也不丢事件 */
let dragging = false;
let lastReloadAt = 0;

/* ------------------------------------------------------------------
   屏幕适配：所有尺寸都从 screen API 现场读，不写死分辨率 / 平台
   ------------------------------------------------------------------ */

/** 一行一块地描述当前所有显示器（尺寸 / 缩放 / 工作区），用于启动自检与日志 */
function describeDisplays() {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen
    .getAllDisplays()
    .map((d, i) => {
      const a = d.workArea;
      const tag = d.id === primaryId ? " [主]" : "";
      return `#${i + 1} 屏幕 ${d.size.width}×${d.size.height}${tag} 缩放 ${d.scaleFactor}x · 工作区 ${a.width}×${a.height} @${a.x},${a.y}`;
    })
    .join("\n           ");
}

/** 启动自检：把「这台机器是什么系统 / 什么屏」打印出来，便于对照排错 */
function logEnvironment() {
  console.log(
    `[pet] 运行环境 ${process.platform}/${process.arch} · Electron ${process.versions.electron} · Chromium ${process.versions.chrome}\n` +
    `[pet] 检测到 ${screen.getAllDisplays().length} 块显示器：\n           ${describeDisplays()}`,
  );
}

/** 窗口该铺在哪块屏：优先它现在所在的那块（拔掉副屏后自然退回主屏） */
function targetDisplay() {
  if (win && !win.isDestroyed()) {
    const d = screen.getDisplayMatching(win.getBounds());
    if (d) return d;
  }
  return screen.getPrimaryDisplay();
}

/** 把窗口重新铺满目标显示器的工作区；已经贴合就不重复调用 setBounds */
function fitToDisplay(reason) {
  if (!win || win.isDestroyed()) return;
  const d = targetDisplay();
  const a = d.workArea;
  const b = win.getBounds();
  if (b.x !== a.x || b.y !== a.y || b.width !== a.width || b.height !== a.height) {
    win.setBounds({ x: a.x, y: a.y, width: a.width, height: a.height });
  }
  console.log(
    `[pet] ${reason} → 铺满 ${a.width}×${a.height} @${a.x},${a.y}（缩放 ${d.scaleFactor}x）`,
  );
}

/** 显示器事件会连发，防抖后再重排一次 */
function scheduleRefit(reason) {
  if (refitTimer) clearTimeout(refitTimer);
  refitTimer = setTimeout(() => {
    refitTimer = null;
    if (!win || win.isDestroyed()) return;
    console.log(`[pet] 显示器变化：\n           ${describeDisplays()}`);
    fitToDisplay(reason);
  }, REFIT_DEBOUNCE_MS);
}

/** 平台专属设置：Windows/Linux 无非必要项，macOS 需要额外两步 */
function applyPlatformTweaks() {
  if (!win || !IS_MAC) return;
  // 1) 透明置顶窗在 macOS 上默认只活在当前 Space，切桌面 / 进全屏应用就「消失」了
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 2) 桌宠不该在 Dock 里占一格（退出走右键菜单「🚪 退出桌宠」或 ⌘⌥⇧Q）
  app.dock?.hide();
}

function createWindow() {
  // 铺满目标显示器工作区（不含任务栏；macOS 不含菜单栏与 Dock）：
  // 桌宠的舞台就是整块桌面，任务栏那一圈留给系统。
  const area = targetDisplay().workArea;

  win = new BrowserWindow({
    width: area.width,
    height: area.height,
    x: area.x,
    y: area.y,
    transparent: true,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: require("path").join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // 置顶到「屏保层」，尽量压住普通窗口
  win.setAlwaysOnTop(true, "screen-saver");
  // 平台差异（macOS：所有桌面可见 + 隐藏 Dock 图标）
  applyPlatformTweaks();

  // 默认整窗穿透；命中与否交给主进程轮询光标（见 startHitTracking）
  setIgnore(true);
  startHitTracking();

  // showInactive：桌宠浮出来时不抢当前 App 的焦点（正在打字 / 看视频不被打断）
  win.once("ready-to-show", () => {
    if (!win) return;
    fitToDisplay("启动");
    win.showInactive();
  });

  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(
      `[pet] 页面加载失败 code=${code} desc=${desc} url=${url}\n` +
      `      请确认 Next dev server 已在 http://localhost:3000 运行（cd frontend && npm run dev）`,
    );
  });

  // 页面重载后旧的命中矩形作废，先清空，等渲染进程重新上报
  win.webContents.on("did-start-loading", () => {
    hitRects = [];
  });

  // 渲染进程崩溃 / 卡死时自愈，避免留下一个「碰不到也拖不动」的幽灵窗口
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error(`[pet] 渲染进程退出（${details.reason}），尝试重载`);
    reload();
  });
  win.webContents.on("unresponsive", () => {
    console.error("[pet] 页面无响应，尝试重载");
    reload();
  });

  win.loadURL(PET_URL);

  win.on("closed", () => {
    dragging = false;
    stopHitTracking();
    win = null;
  });
}

/** 带冷却的重载：崩溃时不会陷入 reload 死循环 */
function reload() {
  if (!win) return;
  const now = Date.now();
  if (now - lastReloadAt < RELOAD_COOLDOWN_MS) return;
  lastReloadAt = now;
  hitRects = [];
  win.reload();
}

/** 统一切换整窗穿透，避免重复调用 */
function setIgnore(next) {
  if (!win || next === ignoring) return;
  ignoring = next;
  if (next) win.setIgnoreMouseEvents(true, { forward: true });
  else win.setIgnoreMouseEvents(false);
}

/**
 * 主进程自持的命中判定：每 HIT_INTERVAL_MS 读一次光标屏幕坐标，
 * 与「窗口 bounds + 渲染进程上报的窗口内矩形」比对。
 * 命中 → 关穿透（可点 / 可拖）；不命中 → 恢复穿透（点透明处落到桌面）。
 */
function startHitTracking() {
  if (hitTimer) return;
  hitTimer = setInterval(() => {
    if (!win) return stopHitTracking();
    // 拖动中把窗口整体当作可交互：指针甩出桌宠也不会丢 pointermove
    if (dragging) return setIgnore(false);

    const cursor = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const hit = hitRects.some(
      (r) =>
        cursor.x >= b.x + r.left - HIT_PAD &&
        cursor.x <= b.x + r.left + r.width + HIT_PAD &&
        cursor.y >= b.y + r.top - HIT_PAD &&
        cursor.y <= b.y + r.top + r.height + HIT_PAD,
    );
    setIgnore(!hit);
  }, HIT_INTERVAL_MS);
}

function stopHitTracking() {
  if (hitTimer) {
    clearInterval(hitTimer);
    hitTimer = null;
  }
}

/* 渲染进程上报「哪些区域算桌宠」：窗口内 CSS 像素的矩形数组 */
ipcMain.on("pet:hit-rects", (_e, rects) => {
  hitRects = Array.isArray(rects)
    ? rects
      .filter(
        (r) =>
          r &&
          Number.isFinite(r.left) &&
          Number.isFinite(r.top) &&
          Number.isFinite(r.width) &&
          Number.isFinite(r.height) &&
          r.width > 0 &&
          r.height > 0,
      )
      .slice(0, 8)
    : [];
});

/* 长按拖动桌宠：窗口本身不动（已铺满屏），主进程只负责在拖动期间别穿透 */
ipcMain.on("pet:drag-start", () => {
  dragging = true;
});
ipcMain.on("pet:drag-end", () => {
  dragging = false;
});

ipcMain.on("pet:quit", () => {
  dragging = false;
  app.quit();
});

app.whenReady().then(() => {
  // 先做一次环境自检，再根据实际检测结果开窗
  logEnvironment();

  // 屏幕变化兜底：插拔显示器 / 改分辨率 / 改缩放 / 隐藏任务栏（macOS 进出全屏）
  // 都会让 workArea 变化，重新铺满一次，桌宠始终贴着屏幕边。
  screen.on("display-added", () => scheduleRefit("接入显示器"));
  screen.on("display-removed", () => scheduleRefit("移除显示器"));
  screen.on("display-metrics-changed", () => scheduleRefit("屏幕参数变化"));

  createWindow();
  // 兜底逃生口：万一窗口又变成「碰不到」，用快捷键也能重载或退出
  globalShortcut.register("CommandOrControl+Shift+Alt+R", () => reload());
  globalShortcut.register("CommandOrControl+Shift+Alt+Q", () => {
    dragging = false;
    app.quit();
  });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  stopHitTracking();
  if (refitTimer) clearTimeout(refitTimer);
});

app.on("window-all-closed", () => {
  dragging = false;
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
