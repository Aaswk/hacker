// 人类观察站 · 桌面桌宠壳（Electron 主进程）
//
// 职责：
//  - 开一个「透明 / 无边框 / 置顶 / 不进任务栏」的窗口，加载 Next 的 /pet 路由。
//    窗口铺满主显示器工作区（不含任务栏），也就是「边缘刚好贴着屏幕边」——
//    桌面整块都是桌宠的舞台，所以拖动不再是移窗，而是桌宠自己在整屏内移动
//    （由渲染进程的 PetDock 负责，主进程只标记「拖动中，别穿透」）。
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

/** @type {BrowserWindow | null} */
let win = null;
/** @type {NodeJS.Timeout | null} */
let hitTimer = null;
/** 渲染进程上报的命中区域（窗口内 CSS 像素）；与窗口 bounds 相加即屏幕坐标 */
let hitRects = [];
/** 当前是否整窗穿透；null = 尚未向系统设置过 */
let ignoring = null;
/** 是否正在「长按拖动桌宠」：拖动期间保持可交互，指针甩出桌宠也不丢事件 */
let dragging = false;
let lastReloadAt = 0;

function createWindow() {
  // 铺满主显示器工作区（不含任务栏）：桌宠的舞台就是整块桌面。
  // 任务栏那一圈留给系统，桌宠不会被拖到任务栏底下被挡住。
  const area = screen.getPrimaryDisplay().workArea;

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

  // 默认整窗穿透；命中与否交给主进程轮询光标（见 startHitTracking）
  setIgnore(true);
  startHitTracking();

  win.once("ready-to-show", () => win && win.show());

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
});

app.on("window-all-closed", () => {
  dragging = false;
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
