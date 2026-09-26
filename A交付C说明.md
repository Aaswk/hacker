# A → C 交付说明：送帧契约与联调方法

> 交付方：A（前端 / 桌宠 / 摄像头）
> 接收方：C（Vision / AI：人体检测、Pose、动作识别、VLM）
> 分工定位：**A 的输入 = B 的 `Observation`；A 的输出 = Camera Frame（给 C）+ 用户界面**
> 目的：让 C 能在本机接住 A 的送帧、按契约返回事件，并自证「C 识别 → C 提交 B」整条链路成立。

> 说明：A ↔ B 的接口（`/observations`、`/events`、`/species-card`、`/subjects/{id}`）在
> 另一份文档 **《A交付B说明.md》** 里，本文只覆盖 A → C。

---

## 1. 角色与数据流

整个项目里，**A 与 C 之间只有一个接口**：

```
浏览器摄像头（A）
      │  captureFrame()：video → 降采样 JPEG Blob（不落盘）
      ▼
   POST http://localhost:8002/frame     ← A → C 的唯一接口
      │  multipart/form-data：frame（JPEG） + timestamp（带时区 ISO 8601）
      ▼
        C（检测 / Pose / 动作识别 / VLM）
      │
      ├─ 有新事件 ─→ 200 + Event JSON           → A 用 onEvent 收到（唯一即时信号）
      └─ 无新事件 ─→ 204 空体（首选）           → A 记一次「无新事件」，循环继续

        C 自己负责 ─→ POST http://localhost:8001/events （C → B，A 不参与）
                            │
                            ▼
                     B 落库 → GET /observations → A 轮询拿到 pet_state + message → 桌宠/气泡/日志
```

**关键边界（本项目的分工铁律）**：

- **A 只送画面，不做任何识别**（`capture.ts` 顶部注释即此约定）。
- **A 拿到 C 的 `/frame` 响应后，只使用 `event` 字段**，不做状态映射、不转写文案。
- **A 不替 C 提交 B 的 `/events`**。C 识别到事件后，**由 C 自己 POST 给 B**。
  桌宠的 `pet_state` 与气泡 `message` 一律来自 B 的 `Observation`（A 轮询 B 得到），C 的 `/frame` 响应里不含这两个字段。
- C 的 `/frame` 响应**不是 `Observation`**，A 也不把它当 `Observation` 处理。

---

## 2. A 实际发出的请求长什么样

`lib/api.ts` 的 `sendFrame()` + `features/camera/capture.ts` 的 `captureFrame()` 决定了下述所有细节：

```
POST {NEXT_PUBLIC_VISION_URL}/frame        # 默认 http://localhost:8002/frame
Content-Type: multipart/form-data          # 浏览器自动带 boundary，A 不手动设置
Origin: http://localhost:3000              # 浏览器自动带，C 必须放行

frame     = image/jpeg 文件
            文件名 frame-<毫秒时间戳>.jpg
            最长边 ≤ 1280 px（等比缩放，不放大原图）
            JPEG 质量 0.7
timestamp = 带时区 ISO 8601，如 2026-09-25T21:08:32+08:00
```

| 参数 | 取值 | 来源 |
| --- | --- | --- |
| 抽帧间隔 | **500ms（约 2 FPS）** | `useFrameReporter` 默认 `intervalMs = 500` |
| 单拍超时 | **10s** | `sendFrame` 默认 `FRAME_TIMEOUT_MS = 10000` |
| 最长边 | **1280px** | `captureFrame` 默认 `maxEdge = 1280` |
| JPEG 质量 | **0.7** | `captureFrame` 默认 `quality = 0.7` |
| `timestamp` 格式 | 带时区偏移的 ISO 8601 | `useFrameReporter.isoWithOffset()` |

> 画面**不落盘**：抓到的只是内存里的 `Blob`，用完即被 GC；`blob` 不写入磁盘、不上传第三方。

---

## 3. 响应契约与 A 的判定表

C 的响应状态直接决定 A 的行为，请对照下表（实现见 `lib/api.ts` 的 `sendFrame`，自检见第 7 节）：

| C 的响应 | A 的判定 | A 的行为 | 建议 |
| --- | --- | --- | --- |
| **204 空体** | 无新事件 | `{ kind: "none" }`，计一次 `noEventCount`，循环继续 | ✅ **首选语义** |
| 200 + 空体 | 无新事件 | `{ kind: "none" }`，同上 | 可用，但建议改用 204 |
| 200 + 非 JSON | 无新事件 | `{ kind: "none" }`，并 `console.warn` 一条 | 避免 |
| 200 + JSON 但无合法 `event` | 无新事件 | `{ kind: "none" }`，并 `console.warn` 一条 | 避免 |
| **200 + 合法 `event`** | **有新事件** | `{ kind: "event" }` → 触发 `onEvent(event)`，计一次 `eventCount` | ✅ 有事件分支 |
| 其他 2xx | 无新事件 | `{ kind: "none" }` | 避免 |
| 非 2xx | 错误 | 抛 `ApiError("帧上报失败：HTTP <status>")`，计一次 `failureCount` | 不要用 4xx/5xx 表达「无事件」 |
| 超时（>10s） | 错误 | 抛 `ApiError("帧上报超时")` | — |
| 网络失败 | 错误 | 抛 `ApiError("帧上报网络错误")` | — |

**A 侧的类型**（`lib/api.ts`）：

```ts
export type FrameResult =
  | { kind: "event"; event: VisionEvent; raw: unknown }
  | { kind: "none"; raw: unknown };
```

**`VisionEvent` 形状**（`types/contract.ts`，A 只强校验 `event`）：

```ts
export interface VisionEvent {
  event: HumanEventType;   // 6 枚举之一，必填
  confidence?: number;     // 可选，A 不读
  timestamp?: string;      // 可选，A 不读
  subject_id?: string;     // 可选，A 不读
}
```

- `event` 必须是 6 枚举之一：`PERSON_ENTER / DRINKING / STRETCHING / PERSON_LEFT / PERSON_RETURNED / UNKNOWN`。
  不在枚举内 → A 按「无新事件」处理并打 warn。
- 其余三个字段 A **不读、不依赖**：C 提交给 B 时自行携带即可（`confidence`、`timestamp`、`subject_id`）。

**异常隔离**：以上任一错误只影响**当前这一拍**，上报循环不会中断（`useFrameReporter` 的 `tick()` 每拍独立 try/catch）。

---

## 4. A 拿到事件后做什么

`useFrameReporter` 的 `onEvent?.(event)` 是 **C → A 的唯一即时信号**：

- 它拿到的是完整的 `VisionEvent`，但 A 目前**只用 `event` 做即时提示/计数**；
- A **不会**在 `onEvent` 里生成 `pet_state` / 气泡文案 —— 这些仍由 `useObservationFeed` 轮询 B 的 `GET /observations` 得到（保证桌宠与气泡的文案始终以 B 为准，单一数据源）；
- 因此**即使 C 的识别很快，用户看到的动作/气泡仍会等到 B 落库后（≤2s 轮询）才更新**，这是刻意的：状态与文案的唯一来源是 B（本地小剧场除外，见下条）。
- **A 侧另有一条与 C / B 都无关的「本机待机小剧场」**：桌宠空闲时偶尔冒一两条本地台词（无事闲聊 / 外星趣事 / 自说自话，以及基于本会话计数生成的「延伸分析」）。已刻意调低到**以发呆为主**——心跳 11–22s 一次，其中约 58% 是 `IDLE` 发呆、约 16% 左右溜达，只有约 10% 会出气泡。这些台词**不写入 B 的库、也不消费 C 的 `event`**，只为桌宠「有生命感」；**看到气泡不等于 C 识别到了什么**。

> 换句话说：`/frame` 这条链路负责「让 C 有画面可看」；桌宠的**正式表现（真实观察）**完全由 B 的 `Observation` 驱动，本机待机小剧场只是点缀。

---

## 5. 职责边界（谁调谁）

| 接口 | A | B | C |
| --- | --- | --- | --- |
| `POST /frame`（8002） | **发起方** | — | 接收方 |
| `POST /events`（8001） | 仅 `/live` Mock 按钮 | 接收方 | **正式链路的发起方** |
| `GET /observations`（8001） | 轮询方（每 2s） | 提供方 | — |
| `GET /species-card`、`GET /subjects/{id}`（8001） | 消费方 | 提供方 | — |

- C 提交 B 的 `HumanEvent` 形状：`{ subject_id, event, confidence, timestamp }`
  - `subject_id`：B 目前只认 `"HUMAN_001"`
  - `confidence`：0 ~ 1
  - `timestamp`：**必须带时区**的 ISO 8601（B 会校验；A 用的格式是 `2026-09-25T21:08:32+08:00`）

---

## 6. CORS

C 的服务必须放行 A 前端的 Origin：

```
http://localhost:3000      （若前端换端口/域名，需同步放行）
```

- 需在**正常响应**和**错误响应**上都带 `Access-Control-Allow-Origin`（自检脚本会分别检查）。
- 若 C 用 FastAPI：`CORSMiddleware(allow_origins=["http://localhost:3000"], allow_methods=["*"], allow_headers=["*"])`，且注意不要因为缺 CORS 头让浏览器把这一拍判为「帧上报网络错误」。

---

## 7. 自检脚本：`npm run check:c`

A 提供了一个零依赖的 Node 脚本（Node 20+ 直接跑），C 用来核对契约与链路。
脚本内的 `isoWithOffset()`、multipart 构造方式与 A 的 `useFrameReporter` / `sendFrame` **完全一致**，是「A 会怎么发」的可执行镜像。

```powershell
cd "d:\3G实验室\学习和发表\黑客松比赛\hacker\frontend"
npm run check:c                                  # 连通性 + CORS + 入参校验（不需要图片）
npm run check:c -- --frame shot.jpg              # 完整契约测试（需一张真实 JPEG，如截一张图存 shot.jpg）
node scripts/check-c-frame.mjs http://localhost:8002 --frame shot.jpg --b http://localhost:8001
```

参数：`[C_URL]`（默认 `http://localhost:8002`）、`--frame <jpg 路径>`、`--b <B 地址>`（默认 `http://localhost:8001`）。

覆盖 **3 节**：

1. **端点存在性 + 入参校验**：故意**不发 `frame` 字段**，期望 C 返回 4xx（证明 C 校验了必填字段）；同时检查错误响应也带 CORS 头。
   - 若此时 `POST /frame` 直接不可达（C 没起 / 端口不对 / 路径不是 `/frame`），脚本以 `fail("POST /frame 可达")` 结束（正好用来区分「C 没起」和「契约不符」）。
2. **完整契约（真实 JPEG）**：用真实帧发一拍，按第 3 节的判定表给出 PASS/WARN/FAIL 结论，并检查单拍耗时与 CORS 头。
   - 不加 `--frame` 时该节跳过（WARN：「响应语义未验证」）。
3. **C → B 上报链路**：先记录 B 的 `max(observation_id)` 基线，再轮询等待最多 **10s**，若 B 出现更大的 id → PASS，证明「**C 识别 → C 提交 `/events` → B 落库 → A 可读**」整条链路成立；否则 WARN（可能是这一帧确实没识别到事件，也可能是 C 没上报 —— 对镜头做一次明确动作再跑一次即可区分）。

全 PASS 退出码 0；有 FAIL 退出码 1。

---

## 8. 当前接线现状与接入方式

**如实说明：送帧能力已实现，但尚未接线到任何页面。**

- `features/camera/useFrameReporter.ts`：完整实现了「抽帧 → 送 C → 处理往返 → 计数/回调」，且已就绪（`intervalMs` / `onEvent` 可配）。
  - **本轮 `/` 已去掉摄像头预览画面**（`features/camera/CameraPreview.tsx` 已删除）：未授权时左下角只有一颗「📷 开启摄像头」pill；授权成功后连 pill 也消失，`video` 变成 `1px × 1px`、`opacity:0` 的隐藏元素（**刻意不用 `display:none`**，否则浏览器可能不渲染帧、`captureFrame()` 会抓到空白）。截帧链路因此仍然可用。
  - 更早的 Step 1 组件 `CameraPanel.tsx` / `CameraPermissionGuide.tsx` 已删除。
  - `/pet`（供 Electron 桌面壳加载的透明桌宠页）：**不带摄像头**，因此也**不会送帧给 C**；桌面版只做「桌宠 + 轮询 B」。
    （桌面壳窗口本身已改为**铺满主显示器工作区**的透明置顶窗、桌宠可在整屏被拖动——这纯属 A 侧桌面呈现，**与送帧契约无关**，C 不需要任何改动。）
- 但全仓检索确认：**当前没有任何页面 import 它**。
  - `/`（首页）已是 **Step 8 单屏桌面**：萌系授权卡「👽 我需要借用你的眼睛来观察人类」→ 桌宠常驻右下角，并自动轮询 B 的 `/observations`。它只负责「授权 + 轮询」，**同样没有 import `useFrameReporter`**。
  - `/live` 的摄像头仅在点「🧬 物种卡」时抓一帧用于卡片配图，**不做连续送帧**。
- 因此现在跑 `npm run check:c` 验证的是 **C 的契约**，不是 A 前端在真实页面上送帧；页面级送帧在 `/` 或 `/live` 任一页接一行即可（见下）。

**接入方式（以 `/live` 为例，各字段均来自现有对象）**：

```tsx
const camera = useCamera({ autoStart: false });      // 复用现有摄像头状态机
const reporter = useFrameReporter({
  videoRef: camera.videoRef,
  cameraReady: camera.status === "ready",            // 未就绪时空转等待，不起帧
  intervalMs: 500,                                    // 约 2 FPS
  onEvent: (event) => {                               // C → A 的唯一即时信号
    // 仅做即时提示/日志；pet_state 与 message 仍由轮询 B 得到
    console.info("C 报告事件：", event.event);
  },
});
// 用户点「开始观察」时：camera.start() + reporter.start()；停止时 reporter.stop() + camera.stop()
```

> 接线后，`reporter` 会暴露 `successCount / eventCount / noEventCount / failureCount / lastReport`，可直接在页面上显示送帧节奏，便于和 C 联调。

> **桌面（`/`）也按同一方式接入**：`DesktopExperience.tsx` 里 `useCamera` 已解构出 `videoRef` 与 `cameraStatus`（`videoRef.current` 挂在左下角那个 **1px 隐藏 `video`** 上，元素常驻渲染、流不断），只需在 `entered` 之后 `reporter.start()`（授权成功后自动开始送帧），并把 `cameraReady` 传成 `cameraStatus === "ready"`。
>
> 注意：桌面版 `/pet` 是独立于 `/` 的桌面桌宠页，**不带摄像头**，不需要在此接线；送帧只需要在 `/`（或 `/live`）接一次。

### 8.1 关于「主动检测」：当前为 A 侧本地模拟，等 C 的动作识别接管

A 端 `usePetBehavior` 里已有一条**主动检测**链路（心跳闸门 `nextScanAtRef`，首次约 24–36s、之后约 42–72s 触发一条），
目前它**不消费任何 C 的输出**，只用 A 本会话采集的用户行为计数（`SessionStats`：接触次数 `taps`、高速位移 `fasts`、离席 `leaves`、静止时长 `idleMins`）生成一段「延伸分析」文案，例如：

- `延伸分析：本场观察已进行 3 分钟，HUMAN #001 主动接触 2 次，互动意愿指数 +14%`
- `久坐预警：HUMAN #001 已连续静止 10 分钟，痔疮风险较基准上涨 0.50%`
- `趋势推测：按当前接触频率，HUMAN #001 对本观察舱的信任度约 48%，建议继续投喂好奇心`

**这是刻意的占位实现**：先让「桌宠会主动开口做分析」这一体验成立，等 C 的动作识别上线后再把它替换为「C 识别 → B 落库 → A 轮询」。届时两条路线的分工不变：

- C 只负责识别并 `POST /events`（A 不参与）；
- A 仍只从 B 的 `Observation` 取 `pet_state` + `message` 来驱动动作与气泡；
- A 的本地 `analysisLines()` 可作为「C 长时间没有新事件时」的兜底闲聊保留（不写 B、不影响 C 链路）。

> 换句话说：**C 上线动作识别后，无需为「主动检测」额外新增任何 A ↔ C 接口**，沿用现有 `/frame` + `POST /events` 即可。

---

## 9. 待 C 确认的点

1. **「无新事件」用哪个状态码**：A 的首选是 **204 空体**（第 3 节判定表已兼容 200 空体，但建议定稿为 204）。
2. **CORS**：C 的**所有**响应（含 4xx/错误响应）都要带 `Access-Control-Allow-Origin: http://localhost:3000`。
3. **`/frame` 的必填校验**：缺少 `frame` 字段时应返回 4xx（自检第 1 节据此判断）。
4. **限流 / 并发**：A 按约 **2 FPS**（500ms 一拍）连续送帧，单拍超时 10s；C 需要确认能否承受该速率，以及是否需要 A 降频/退避（如连续失败时自动放慢）。
5. **是否下发 `subject_id`**：A 目前只读 `event`；若 C 会在 `/frame` 响应里带 `subject_id`，A 也不需要（`subject_id` 由 C 提交给 B）。请确认 C 提交 B 时固定用 `"HUMAN_001"`。
6. **事件去重**：同一动作 C 是否会在连续多拍里重复上报同一 `event`？若会，需由 C 自行做去抖，否则 B 会收到重复事件（A 侧不做去重，去重只依据 B 的 `observation_id`）。
7. **动作识别上线后的事件粒度**：A 目前的「主动检测」是本地模拟（见第 8.1 节）。请 C 明确：识别到的动作是否只走「C → B `/events` → A 轮询」这一条路？A 不需要在 `/frame` 响应里读 `pet_state` / 文案，也不需要 C 另开接口。
8. **「久坐 / 静止」类事件是否会新增**：A 端本地模拟里已有「持续静止 → 久坐预警」的文案雏形；若 C 上线后可稳定输出「长时间静止」这类事件，A 会优先采用 B 下发的 `message`，本地模拟自动让位。请确认是否需要新增对应 `event` / `pet_state`（新增需同步 A 的 `types/contract.ts`）。
