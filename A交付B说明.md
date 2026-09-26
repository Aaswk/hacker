# A → B 交付说明：前端代码与启动方法

> 交付方：A（前端 / 桌宠 / 摄像头）
> 接收方：B（后端 / 观察记录服务）
> 分工定位：**A 的输入 = B 的 `Observation`；A 的输出 = 用户界面（+ 送 C 的 Camera Frame）**
> 目的：让 B 能在本机跑起 A 的前端，并确认 A 是否正确、完整地消费 B 的
> `GET /observations`、`POST /events`、`GET /species-card`、`GET /subjects/{id}`。

> 说明：A ↔ C 的送帧契约在另一份文档 **《A交付C说明.md》** 里，本文只覆盖 A ↔ B。

---

## 1. 代码位置

```
hacker/frontend/            ← A 的前端工程（Next.js，独立于 B 的 app.py）
hacker/frontend/app/        ← 页面（/ 桌面、/pet 透明桌宠页、/live 联调、/pet-preview 预览）
hacker/desktop/             ← A 的 Electron 桌面壳（把 /pet 变成一个真正的桌面桌宠，见第 9 节）
```

关键文件（B 只需关注「消费 B 接口」的那几处）：

| 文件 | 作用 |
| --- | --- |
| `frontend/lib/api.ts` | 所有对 B / C 的请求封装；`isObservation` 逐字段校验 B 的响应 |
| `frontend/types/contract.ts` | 契约类型源：7 `pet_state` / 6 `event` 枚举 + `Observation` / `SpeciesCard` / `SubjectSummary` |
| `frontend/hooks/useObservationFeed.ts` | **轮询 B 的 `GET /observations`**，按 `observation_id` 增量识别新记录 |
| `frontend/hooks/usePetState.ts` | Step 5 状态映射层：`Observation` → 动作 / 气泡 / 日志（内部包装 `usePetBehavior`） |
| `frontend/hooks/usePetBehavior.ts` | 桌宠行为引擎 + 气泡台词池 + 用户行为触发（待机小剧场）；`/pet-preview` 直接用它 |
| `frontend/hooks/useCamera.ts` | 摄像头授权 / 取流（Step 2） |
| `frontend/components/ObservationBubble/` | 观察气泡（`react-fukidashi`，语气芯片：观察记录 / 警戒 / 新发现） |
| `frontend/components/Pet/` | 桌宠渲染（`public/boxcat.webp` 图集 + overlay 画布） |
| `frontend/components/LogDrawer/` | Step 6 观察日志抽屉（`animal-island-ui` Drawer） |
| `frontend/components/SpeciesCard/` | Step 7 物种卡弹窗；同目录 `archive.ts` 是立案门槛 / 台词 / 抓拍转 data URL 的共享工具 |
| `frontend/components/PetDock/PetDock.tsx` | **桌宠外壳（页面/桌面两种模式共用）**：悬停才浮现的 📓 / 🧬 入口、单击戳一戳、长按拖动移位、右键菜单（隐藏气泡 / 退出桌宠） |
| `frontend/features/desktop/DesktopExperience.tsx` | **Step 8 单屏桌面体验（挂在 `/`）**：授权卡 → 桌宠常驻右下角 → 气泡 → 📓 / 🧬 悬停浮现在桌宠身上；摄像头**不做画面预览**，只留一个 1px 隐藏 `video` 供截帧 |
| `frontend/features/desktop/PermissionGate.tsx` | Step 8 首次进入的萌系摄像头授权卡（`animal-island-ui` Card + pill Button） |
| `frontend/features/camera/capture.ts` | 从 video 截一帧 → 降采样 JPEG Blob（供送 C / 物种卡抓拍）；**video 元素虽不可见但常驻渲染，截帧链路不断** |
| `frontend/features/camera/useFrameReporter.ts` | 抽帧上报 C 的 hook（见《A交付C说明.md》）；**当前未接线到任何页面** |
| `frontend/app/page.tsx` | **首页 = Step 8 桌面**：只渲染 `DesktopExperience` |
| `frontend/app/pet/page.tsx` | **透明桌宠页（供 Electron 壳加载）**：透明背景 + 每 120ms 把 `[data-pet-hit]` 矩形上报主进程（弹层打开时只上报面板 `[role="dialog"]`，不吞桌面点击） |
| `frontend/types/electron.d.ts` | `window.petAPI` 的类型声明（`setHitRects` / `dragStart` / `dragEnd` / `quit`） |
| `desktop/main.js` | **Electron 主进程**：铺满主显示器工作区（不含任务栏）的透明 / 无边框 / 置顶 / 跳过任务栏窗口；鼠标穿透命中判定 + 拖动期间保持可交互 |
| `desktop/preload.js` | `contextBridge` 暴露 `window.petAPI`（`contextIsolation` 开启，渲染层不碰 Node） |
| `frontend/app/live/page.tsx` | A ↔ B 联调页（本说明第 4 节用它验收），接线 `usePetState` |
| `frontend/app/pet-preview/page.tsx` | Step 3/4 纯前端预览页（7 状态按钮 / 全景 / 连发 3 条），接线 `usePetBehavior` |
| `frontend/scripts/check-b-contract.mjs` | B 接口契约自检（见第 5 节） |
| `frontend/scripts/b-stub-server.mjs` | B 未启动时代的 Node 桩服务（见第 7 节） |

> 各页面用的状态层不同，B 验收时注意：
> - `/`（**Step 8 桌面**）→ `usePetState`（`usePetBehavior` + B 的 `Observation`），授权后自动开始轮询
> - `/pet`（**透明桌宠页**）→ 同样 `usePetState`，但**独立轮询** B（与 `/` 各拉一份，互不影响）；供 Electron 壳加载
> - `/live` → `usePetState`（同上，另有手动「开始观察」与 Mock `POST /events` 的联调控件）
> - `/pet-preview` → `usePetBehavior`（不接 B，纯本地小剧场）
>
> Step 8 同时**清理**了 Step 1 的两个旧文件：`features/camera/CameraPanel.tsx` 与
> `features/camera/CameraPermissionGuide.tsx` 已删除，其摄像头开关 / 异常引导职责
> 由 `features/desktop/` 下的授权卡承接。
> 本轮又删除了 `features/camera/CameraPreview.tsx`（摄像头不再做画面预览）：
> `/` 只在左下角留一颗「📷 开启摄像头」pill，授权后 video 变成 1px 隐藏元素，画面不显示但可截帧。
> `capture.ts`、`useFrameReporter.ts` 保留。

`package.json` 里已封装好的命令：

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动前端，监听 3000 |
| `npm run build` / `npm run start` | 生产构建 / 启动 |
| `npm run lint` | ESLint |
| `npm run check:b` | B 接口契约自检（只读；加 `-- --write` 才会真的 POST /events）；**默认打 `http://localhost:8001`** |
| `npm run check:c` | C 的 `/frame` 契约自检（见《A交付C说明.md》） |

---

## 2. 启动方法

```powershell
cd "d:\3G实验室\学习和发表\黑客松比赛\hacker\frontend"
npm install
npm run dev
```

- 前端监听：**http://localhost:3000**（端口与 A 文档约定一致）
- **主入口 / Step 8 桌面：http://localhost:3000/**（授权摄像头 → 桌宠常驻右下角，自动轮询 B）
- A ↔ B 联调页：**http://localhost:3000/live**（带手动「开始观察」与 Mock `POST /events` 的控件）
- 桌宠纯前端预览：**http://localhost:3000/pet-preview**（不接 B）
- 透明桌宠页：**http://localhost:3000/pet**（一般不用手动开，由 Electron 壳加载，见第 9 节）

> B 需同时启动自己的 FastAPI（端口 **8001**）：
> `uvicorn app:app --port 8001`（按 B 自己的启动方式为准）

---

## 3. 地址与接口约定

A 端**全部走环境变量**，默认值已对齐团队端口：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:8001` | B 的服务地址 |
| `NEXT_PUBLIC_VISION_URL` | `http://localhost:8002` | C 的服务地址（A ↔ C 用） |

需要覆盖时，在 `frontend/.env.local` 写：

```
NEXT_PUBLIC_API_BASE_URL=http://localhost:8001
NEXT_PUBLIC_VISION_URL=http://localhost:8002
```

> `NEXT_PUBLIC_*` 在编译期内联，**改完必须重启 `npm run dev`**。
> A 的查询类请求超时 5s（`DEFAULT_TIMEOUT_MS`），送帧超时 10s（`FRAME_TIMEOUT_MS`）。

### A 消费的四个 B 接口（字段一律 snake_case，A 未做任何改名）

1. **`GET /observations`** → `list[Observation]`（**裸数组**，不能是 `{items:[]}` 包装）
   - A 取 `observation_id` 去重，按 `observation_id` **升序**补播（兼容 B 的 `ORDER BY id DESC` 返回顺序，A 不依赖数组顺序）
   - 气泡文案**只读 `message`**，不读其他候选字段（不接受 `alien_interpretation` 之类的别名）
   - `subject_id` / `confidence` / `timestamp` 为可选字段，**只有该接口会下发**；缺了退化成占位显示
   - 轮询间隔 2s（`useObservationFeed` 默认 `intervalMs = 2000`），拉全量、本地按 id 增量识别

2. **`POST /events`** → `201 { observation_id, event, pet_state, message }`
   - 正式链路里由 **C** 调用；A 侧只用 `/live` 的「POST /events 造一条（联调）」按钮做 Mock
   - A 用返回体直接喂状态映射层，与轮询链路汇合（靠 `observation_id` 去重）
   - A 会校验返回体是否为合法 `Observation`，不符则抛错（不静默）

3. **`GET /species-card`** → `{ subject_id, summary, event_counts }`（口径源：`types/contract.ts` 的 `SpeciesCard`）
   - A 只读 **`summary`**（string，允许空串 → 前端显示「—」/ 回退兜底文案），显示在物种卡与右栏「记录员手记」
   - `event_counts` 用于右栏累计条数与 **15 条立案门槛**判断
   - 卡片标题「HUMAN #001」由前端固定文案渲染，**不从响应读取**

4. **`GET /subjects/{subject_id}`** → `{ subject_id, total_observations, event_counts }`
   - A 用 `getSubject()` 拉累计行为计数
   - B 当前实现**只认 `HUMAN_001`**，其他 id 返回 **404**

### CORS

B 的 `app.py` 已放行 `http://localhost:3000` / `http://127.0.0.1:3000`，A 端零配置可用。
（B 若改了端口或前端部署到别处，需同步放行对应 Origin。）

---

## 4. B 侧验收步骤（约 3 分钟）

### 4.1 主入口：Step 8 桌面（http://localhost:3000/）

> 这是评委实际看到的界面，B 也可以先跑这条确认「轮询 → 桌宠」链路是通的。

1. 启动 B 的 FastAPI（8001）+ A 的前端（3000）。
2. 打开 **http://localhost:3000/**：先出现一张授权卡（「👽 我需要借用你的眼睛来观察人类」）。
3. 点「**开始体验**」→ 授权摄像头 → 桌宠**从屏幕右侧滑入**，常驻右下角；
   顶部一行引导（「戳一戳右下角的小外星人…」）约 9 秒后自动收回。
   - 不想授权摄像头也可以点「暂时不授权，先看看」，桌宠照样登场（仅轮询链路可用）。
4. **鼠标靠近「桌宠本体 + 两个按钮」这块区域**（含两者之间约 12px 的缝隙）时，两个入口一起浮现（平时 `opacity-0` 隐藏）；移开后约 180ms 才收回。点它们验证 B 链路：
   - 注意：按钮与桌宠**同处一条 `transform` 动画曲线**（桌宠平移 `petX`、按钮平移 `btnDx`，都是 `1.7s linear`），所以按钮始终贴在桌宠旁边、不会被甩开或压住。按钮的横向位置由一个**连续的 `translateX`** 表达（基准位固定在桌宠盒子右侧 12px）：`D = petX` 贴右侧、`D = petX + 317` 贴左侧；右侧会出屏时才改走左侧。因为走的是同一条过渡曲线，**换边时按钮会从桌宠身后平滑「滑过」，不会瞬跳**。**热区把桌宠盒子与按钮盒子各自外扩 12px 一并纳入判定**，因此从桌宠移向按钮的途中不会「隐身」，可正常点到。
   - **📓 日志** → 右侧滑出「HUMAN OBSERVATION LOG」，时间线来自 B 的 `GET /observations`
   - **🧬 物种卡** → 累计 ≥15 条才立案；不足时桌宠怼一句 `样本不足 N/15`（数据来自 B 的 `/species-card`）
   - 摄像头**没有预览画面**：左下角只有一颗「📷 开启摄像头」pill（未授权时可见）；授权成功后连 pill 也消失，只留一个 1px 隐藏 `video` 供截帧
5. 桌宠交互（不影响 B 链路）：
   - **单击**桌宠 → 戳一戳（`ALERT` / 好奇等本机反应）
   - **长按约 0.2s 后拖动** → 桌宠跟着走；**拖动位置被 clamp**，桌宠至少保留 60% 宽高在视口内，不会被推出屏幕边缘只剩一角；松手后就地落脚并继续小范围左右溜达（余量按视口宽取三成，最少 ±120px，宽屏下最大约 ±576px）
   - **右键**桌宠 → 弹出菜单：「🤫 隐藏气泡 / 💬 显示气泡」（隐藏后只默默记录、不再弹气泡，`pet_state` 与出队照常）
   - **气泡自动避让**：桌宠靠近屏幕顶部/底部时，气泡会自动翻到另一侧（`react-fukidashi` 的 `avoidCollisions`），不会被视口裁掉、也不会压在桌宠身上
6. 在 B 侧用任意方式造一条新记录，确认桌宠下一次轮询（≤2s）自动切动作 + 弹气泡（内容为 B 的 `message` 原文）。

### 4.2 联调页：/live（带 Mock 控件）

1. 启动 B 的 FastAPI（8001）+ A 的前端（3000）。
2. 打开 **http://localhost:3000/live**。
3. 点左侧「**○ 开始观察（轮询 B）**」，按钮变成「● 正在轮询 B /observations」即已开始每 2s 拉取。
4. 观察页面三处是否联动：
   - 观察舱下方状态串：`pet_state = "..." · <中文> · 气泡队列 N 条` / `本次已播 N 条 · 已处理到 id M`
   - 观察舱：桌宠切换对应动作 + 弹出气泡（内容为 B 的 `message` **原文**）
   - 点「📓 观察日志」→ 右侧滑出「HUMAN OBSERVATION LOG」抽屉，时间线新增一条（观察描述 + 当前假说 + 置信度条 + B 的 `message` 原文）
5. 用下拉框选一个事件 → 点「**POST /events 造一条（联调）**」，确认三处同时更新（会真的写入 B 的库）。
6. 在 B 侧用任意方式造一条新记录，确认 A 下一次轮询（≤2s）自动补播。
7. 看右栏「**记录员手记（来自 B 的 summary 字段）**」是否显示 B `/species-card` 的 `summary` 原文。
8. 点「🧬 HUMAN #001」：累计记录 ≥15 条才立案出卡；不足时记录员会怼一句并显示 `样本不足 N/15`。

### 实测已通过项（2026-09-26 对照 B 真服务）

| 检查项 | 结果 |
| --- | --- |
| 轮询地址 | `GET http://localhost:8001/observations`（每 2s） |
| 物种卡 | 显示 B 的 `summary` 原文（如 `已记录 29 次观察。该生物持续表现出值得研究的日常行为。`） |
| 动作 | `PERSON_LEFT` → `ALERT`；`DRINKING` → `CURIOUS` |
| 气泡 | B 的 `message` 原文 + 按 `pet_state` 映射的语气芯片 |
| 日志 | 时间线按 `observation_id` 升序、去重 |
| 优先级 | `ALERT` 插队首，不被已在播的 `ALERT` 打断 |
| 状态回落 | 待机小剧场（`playAct` / `playWalk`）演完回 `IDLE`；气泡队列排空后回 `OBSERVING` |
| 待机节奏 | **以「发呆」为主**：心跳到点后 16% 概率左右溜达、58% `IDLE` 发呆、10% `CURIOUS`、6% `THINKING`，其余约 10% 才冒一条气泡（闲聊 / 外星趣事 / 自说自话三等分）；平均每 11–22s 才有一个待机小动作，实测 36s 内没有新动作、桌宠稳在原位 |
| Step 8 桌面 | `/` 授权卡 → 桌宠右侧滑入；气泡右边缘距视口右缘 134px、桌宠平移（视口宽三成）均不越界 |
| Step 8 入口 | 📓 日志 / 🧬 物种卡 **鼠标靠近桌宠才浮现**（默认 `opacity-0`），不出现第二套界面；**桌宠盒子 + 按钮盒子（各外扩 12px）合并热区**，四点实测 `far→HIDDEN / 桌宠→SHOWN / 中间缝隙→SHOWN / 按钮→SHOWN`；按钮的横向位置由**连续 `translateX(btnDx)`** 表达（基准位固定在桌宠盒子右侧 12px：`btnDx = petX` 贴右侧、`btnDx = petX + 317` 贴左侧），与桌宠走同一条 `1.7s linear` 曲线，**溜达时平行跟随、换边时从桌宠身后平滑滑过（不瞬跳）**；右侧会出屏（`R + petX + 305 > vw`）时才改走左侧，保证按钮永不出屏、也不压住桌宠。实测 `/`(1080) 与 `/pet`：`petX=0` 按钮左缘 868 / 652（= 桌宠盒右缘 + 12px）、`petX=-98.6` 按钮左缘 553（桌宠盒右缘 541.4 + 12px），间隙恒定 12px；按钮已不再需要 `z-10`（换边时落在桌宠身后） |
| Step 8 拖动 | page 模式双向 clamp，实测拖到右下极限 `left/top = 960/478`（正好 `1080-120`、`636-158.4`），拖到左上极限 `top = -106`，与 `KEEP_VISIBLE = 0.6` 公式精确一致 |
| Step 8 气泡避让 | 桌宠在屏幕顶部时 `data-placement` 由 `top` 翻为 `bottom`，气泡落在桌宠盒子之下不压身；在中部时为 `top`；`/pet` 下 `.fukidashi-positioner` portal 到 `body`，不被 `main{overflow:hidden}` 裁剪 |
| 主动检测 | 心跳闸门**首次约 70–100s、之后约 120–200s** 触发一条「延伸分析」（只在桌宠空闲且气泡队列空时播）；实测捕获 `延伸分析：本场观察已进行 3 分钟，HUMAN #001 主动接触 2 次，互动意愿指数 +14%` |
| 本地台词池 | 新增无事闲聊 `CHAT` / 外星趣事 `ALIEN` / 自说自话 `MUTTER` 三池，实测弹出 `（打量陈设）记录本快写完了，页脚卷了起来，和上上次一样` |
| Step 8 摄像头 | `/` 已无预览画面；未授权时仅左下角一颗「📷 开启摄像头」pill，`video` 实测 `1px × 1px`、`opacity:0` 常驻渲染 |
| Step 8 引导 | 顶部一行提示约 9s 后自动收回；`prefers-reduced-motion` 下关闭入场动画 |
| 桌宠交互 | 单击戳一戳（实测切到 `ALERT` + 气泡）；右键菜单弹出「🤫 隐藏气泡 / 🚪 退出桌宠」，点隐藏后菜单关闭且 `pet_state` 仍持续变化（气泡仍在出队） |
| 透明桌宠页 | `/pet` 实测 `html/body` 均为 `rgba(0,0,0,0)`、命中节点 `[data-pet-hit]` 宽 200px 居中、无 console 报错 |
| 全屏窗 + 抽屉滑入 | 桌面壳窗口改为铺满工作区后实测：日志抽屉面板宽 **430px**（`max-width` 实测 `1048px`，不再钳制）、关闭态 `left = 100vw`（正好在屏幕右缘外）、打开态 `left = 100vw − 430`；开合中途采样 `left` 从 1080 → 1062 → 650，证明 `.36s` 缓动**真实在跑**；抽屉打开时桌宠盒子仍为 `200×264`（未被 `pushBackground` 缩放）、`<main>` 计算 `transform: none`、`data-animal-drawer-ignore` 生效 |
| 拖动 / 命中（全屏窗） | 主进程 `node --check` 通过、`electron .` 启动无报错；窗口 `width/height = workArea`；拖动期间仅置 `dragging` 标记（`win.setPosition` 已移除），桌宠改自身 `left/top` 并 60% clamp；弹层打开时命中区只含 `[role="dialog"]` |
| 桌面壳静态检查 | `node --check main.js` / `preload.js` 均 exit 0，`electron` v44.4.5 已安装 |
| 代码质量 | `npx tsc --noEmit` exit 0；`npm run lint` exit 0 |
| 接口自检 | `npm run check:b` → **PASS 22 / FAIL 0 / WARN 2**（只读模式；WARN 来自第 7/8 节未加 `--write` 的跳过提示） |

---

## 5. 契约自检脚本（A 提供给 B 用）

零依赖的 Node 脚本（Node 20+ 直接跑），B 改完接口可以自己先跑一遍：

### `frontend/scripts/check-b-contract.mjs`

```powershell
cd "d:\3G实验室\学习和发表\黑客松比赛\hacker\frontend"
npm run check:b                                  # 只读，不写库（默认 http://localhost:8001）
npm run check:b -- --write                       # 额外真 POST /events，验证「写入 → 读出」闭环
node scripts/check-b-contract.mjs http://localhost:8001   # 指定地址
```

覆盖 **8 节**：

1. `GET /observations` 连通性（HTTP 200 / 合法 JSON / 裸数组 / 未触发 5s 超时 / 是否慢于 2s 轮询间隔）
2. 逐条字段与 6 枚举（用 A 的 `isObservation` 口径，逐字段列出不符处）
3. `observation_id` 必须为正整数、无重复（A 用它做本地去重）
4. CORS（OPTIONS 预检 + 实际 GET 响应都要带放行头）
5. `GET /subjects/HUMAN_001` 的 `event_counts`
6. **`GET /species-card` 的 `{ subject_id, summary, event_counts }`**（严格校验形状）
7. `POST /events` 写入 → `/observations` 读出闭环（仅 `--write`）
8. 非法枚举应被拒绝（仅 `--write`，期望 422）

全 PASS 退出码 0；有 FAIL 退出码 1。

> 口径来源同步自 `lib/api.ts` 的 `isObservation` 与 `types/contract.ts`。

---

## 6. A 对 Observation 的处理规则（供 B 对照）

- 契约 7 种 `pet_state`：`IDLE / OBSERVING / THINKING / CURIOUS / CONFUSED / ALERT / EXCITED`
- 6 种 `event`：`PERSON_ENTER / DRINKING / STRETCHING / PERSON_LEFT / PERSON_RETURNED / UNKNOWN`
- 同一个 `observation_id` **只消费一次**（轮询 + `POST /events` 直连两条链路都汇到同一入口，靠 id 去重）
- 气泡语气映射（`usePetState` 的 `STATE_TONE`）：`ALERT` → 警戒配色；`EXCITED` → 新发现配色；**其余 5 种** → 观察记录配色
- 队列规则：B 的真实观察（`observation`）**永不因队列满被丢弃**，会挤掉一条本机待机闲聊；本机闲聊（`ambient`）队列满时直接丢弃
- 动作衔接（`Pet.tsx`）：除 `THINKING`（刻意「飞速记录」、立即切换）外，其余状态以 `IDLE` 为基准起手，带 180ms 稳定 + 380ms 桥接 + 900ms 最短保持的节流，避免高频硬切
- **本机台词（与 B 无关，纯 A 侧）**：`usePetBehavior` 除三档语气池 `POOL`（观察 / 警戒 / 新发现）外，另有四个本地池——无事闲聊 `CHAT`、外星趣事 `ALIEN`、自说自话 `MUTTER`，以及**主动检测** `analysisLines()`（基于本会话用户行为计数，如接触次数、静止时长，生成「延伸分析 / 久坐预警 / 趋势推测」）。这些都不走 B，**不会写入 B 的库、也不消费 B 的字段**；B 的真实 `observation` 仍享有最高优先级（队列满时挤掉本机闲聊）。

---

## 7. 关于本机无 Python：Node 桩服务

A 的实测环境没有 Python，无法启动 B 的 FastAPI，因此 A 用 Node 桩**逐字段复刻**了 `app.py` 的响应形状来联调：

```powershell
cd "d:\3G实验室\学习和发表\黑客松比赛\hacker\frontend"
node scripts/b-stub-server.mjs      # 监听 http://localhost:8001
```

- 复刻端点：`GET /health`、`POST /events`（201）、`GET /observations`（id 倒序）、`GET /subjects/HUMAN_001`、`GET /species-card`
- `NARRATIVE`（6 事件 → pet_state + message）与 B 的 `app.py` **完全一致**
- CORS 同样放行 3000
- **B 的真服务起来后，停掉这个桩、直接用真服务即可，前端无需改任何代码**

---

## 8. 待 B 确认的点

1. `GET /observations` 是否会持续增长、有无分页/上限（A 目前拉全量、客户端增量识别；数据量大时建议加 `?since_id=` 之类的增量参数）。
2. `/species-card.summary` 的生成规则是否稳定（含空串场景：A 目前显示「—」占位）。
3. **`message` 文案是否要多样化**：B 的 `NARRATIVE` 对同一 `event` 输出固定文案，同一个事件刷多次气泡正文会完全一样；A 只读 `message` 原文、不做改写，若需要「同事件不同说法」需 B 侧生成。
4. `GET /subjects/{subject_id}` 目前只支持 `HUMAN_001`，其他 id 一律 404；后续是否会扩展其他 subject。
5. 是否新增事件类型 / `pet_state`（A 的枚举表在 `frontend/types/contract.ts`，新增需同步）。

---

## 9. 桌面桌宠：Electron 壳（让桌宠脱离网页，直接待在桌面上）

B 无需做任何改动即可享用本节；写在这里是为了让 B 知道「桌宠还有桌面形态」，以及它**复用同一条轮询链路**。

### 9.1 为什么不改 B 的接口

桌面壳加载的是 Next 的 `/pet` 路由，与 `/` 同源（`http://localhost:3000`），
数据来源仍是 B 的 `GET /observations`（`/pet` 自己按 2s 独立轮询一份）。
**Origin 不变 → CORS 零影响 → B 不用加白名单。**

### 9.2 启动方法

```powershell
# 1) 先起前端（3000）与 B（8001）
cd "d:\3G实验室\学习和发表\黑客松比赛\hacker\frontend"
npm run dev

# 2) 另开一个终端起桌面壳
cd "d:\3G实验室\学习和发表\黑客松比赛\hacker\desktop"
npm install          # 首次；已装则可跳过
npm run pet          # = electron .
```

- 窗口**铺满主显示器工作区**（不含任务栏，边缘刚好贴着屏幕边），透明 / 无边框 / 置顶 / 不进任务栏。整块桌面就是桌宠的舞台，所以**桌宠能在整屏被拖动 / 溜达**；它默认出现**在中下方（水平居中、离底约 56px）**。
- 目标地址可用环境变量覆盖：`$env:PET_URL="http://localhost:3001/pet"; npm run pet`
  （前端若因端口占用跑到 3001，就用这条）。
- 若前端没起，窗口会打日志提示「先启动前端 dev server」，不会白屏卡死。

### 9.3 穿透与拖动（B 不用管，列给好奇的评委）

- **透明区域鼠标穿透（主进程自持命中判定）**：因为窗口现在**铺满整块工作区**，若不处理，
  这层置顶窗会把整个桌面的点击全吃掉。做法是：整窗默认 `setIgnoreMouseEvents(true)`；
  渲染进程每 120ms 把「哪些区域算桌宠」上报给主进程——即所有 `data-pet-hit` 元素
  （桌宠本体、按钮容器、右键菜单、气泡）在**窗口内的 CSS 像素矩形**，IPC 通道 `pet:hit-rects`。
  主进程另起 24ms 定时器读 `screen.getCursorScreenPoint()`，与「`win.getBounds()` + 上报矩形」比对，
  光标落进任一矩形（外扩 6 DIP）就 `setIgnoreMouseEvents(false)` 恢复可点，移开再放开。
  **桌面其余区域的点击/拖拽不被桌宠挡住**（等效于「只有光标压在桌宠/按钮/弹层面板上时窗口才吃事件」）。
  注意：入口按钮（📓 / 🧬）隐藏时（`opacity-0` + `pointer-events-none`）其矩形**仍然上报**，
  所以桌宠旁边会有一小块「看不见但可交互」的区域；因为紧贴桌宠、面积很小，暂不额外过滤。
  也因此**桌面版的按钮也是「鼠标靠近才浮现」**——先把光标移到桌宠本体上，`setIgnoreMouseEvents(false)`
  恢复后渲染进程才收得到 `pointermove`，按钮随之淡入；这与网页版行为一致。
  这样做的原因：旧写法靠 `setIgnoreMouseEvents(true, { forward: true })` 把 mousemove 转发给渲染进程，
  再由渲染进程 `elementFromPoint` 反推命中——那条转发链路一旦不投递，窗口就会变成
  「看得见、碰不到、拖不动」的幽灵窗口。命中判定下沉到主进程后，只依赖操作系统光标坐标，不再有这条隐患。
- **弹层打开时只上报面板**：日志抽屉 / 物种卡打开时，只把面板本身（`[role="dialog"]`，Drawer 与 Modal 通用）
  并入命中区，**不整窗上报**——否则铺满屏的窗口会把整个桌面都变成可交互区、吃掉所有点击。
  点面板外的桌面照常穿透；退出走面板上的 `×` 或 `Esc`。
- **长按拖动的是「桌宠本身」，不是窗口**：窗口已铺满屏、`win.setPosition` 没有意义。
  pointerdown 起 180ms 计时，超时进入拖动态 → 调 `petAPI.dragStart()`（主进程只置一个 `dragging` 标记：
  「拖动期间整窗保持可交互」，指针甩出桌宠也不会丢 `pointermove`）；桌宠自身改 `left/top` 跟随指针，
  并用 `KEEP_VISIBLE = 0.6` clamp（至少留 60% 宽高在视口内）；松手 `dragEnd()` 复位标记、就地落脚。
- **单击 vs 长按**：拖动中/刚拖完（350ms 内）会抑制 click，避免「拖一下顺带戳一下」。
- **崩溃自愈 + 逃生口**：渲染进程 `render-process-gone` / `unresponsive` 时自动 `reload()`（带 10s 冷却，不会死循环）；
  全局快捷键 `Ctrl+Shift+Alt+R` 强制重载、`Ctrl+Shift+Alt+Q` 退出，窗口万一又变「碰不到」也能自救。
- **技术选型说明**：首选的 Tauri 因本机**没有 Rust 工具链**而放弃，改用 Electron（Node 24 已在，`electron@44` 走 npmmirror 镜像安装）。

### 9.4 与网页版（`/`）的差异（有意为之）

| | `/`（网页版） | `/pet` + Electron（桌面版） |
| --- | --- | --- |
| 背景 | 完整桌面 UI（右栏日志面板等） | 全透明，只有桌宠/气泡 |
| 📓 / 🧬 入口 | 有（鼠标靠近才浮现，随桌宠左右移动而平行移动） | **有（同样鼠标靠近才浮现，随桌宠左右平行移动）**——日志抽屉**从真实屏幕右缘缓缓滑入**（面板宽 430px、`transition transform .36s cubic-bezier(.2,0,.2,1)`）。旧 420×560 小窗里这条滑动几乎看不出来：库的 `max-width: calc(100vw - 32px)` 把 430px 面板钳到 388px（占掉小窗 92% 宽、滑动空间局促），且 `pushBackground` 默认会给桌宠加 `scale(.94)+blur(1px)` 与滑入动画打架。现在窗口铺满屏，`100vw` = 屏幕宽 → 430px 不被钳制、从真实屏幕右缘完整滑入；`/pet` 的 `<main>` 已加 `data-animal-drawer-ignore` 让库跳过推背景，桌宠不再被缩小糊掉。物种卡为居中弹窗；面板外的桌面照常穿透 |
| 摄像头 | 有（隐藏 video 截帧） | **无**（桌面版不带摄像头；只做「陪伴 + 轮询」） |
| 右键菜单 | 「显示/隐藏气泡」 | 「显示/隐藏气泡」+「🚪 退出桌宠」 |
| 拖动边界 | 页内 clamp（至少留 60% 在视口内） | 桌面版窗口已铺满工作区，故**同样拖的是桌宠本身**、同一套 60% clamp（整块桌面都是舞台，可全屏拖动） |
| 气泡 | 靠视口边时自动翻边避让 | 同上（`/pet` 下气泡 portal 到 `body`，不受窗口裁剪） |
| 状态来源 | B 的 `GET /observations` | 同上（独立轮询一份） |
