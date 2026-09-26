#  A 部分实施步骤（前端 / 桌宠 / 摄像头）

> 本文档只定义步骤与每步职责，不含具体实现代码。
> 后续确定使用某个开源模块时，直接替换对应步骤中的「可替换点」。

---

## 0. A 的边界与对外接口

### 0.1 A 负责什么

```
Frontend
Desktop Pet UI
Camera Access
Interaction
Animation
Visualization
Demo Flow
```

一句话：**负责人能看到、能点击、能感受到的全部内容。**

最终责任链中，A 出现两次——**一次在最前面（取画面），一次在最后面（做反应）**：

```
A 前端（相机）── Camera Frame ──→ C 视觉 ── Human Event ──→ B 后端 ── Observation ──→ A 前端（桌宠 / 气泡 / 日志）
```

### 0.2 A 的四个核心视觉组件

**产品存在形式：桌宠，而不是「桌宠 + 一个网站」。**

A 侧采用 **「桌宠 + 观察气泡 + 可展开研究档案」三层结构**，全部功能都从桌宠身上长出来：

```
电脑桌面
   │
   └── 👽 外星桌宠（常驻屏幕角落）
          │
          ├── 实时观察 → 表情 / 动作变化
          │
          ├── 发现行为 → 弹出观察气泡（几秒后自动收回）
          │
          ├── 📓 点击笔记本
          │       ↓
          │   人类观察日志（侧边抽屉）
          │
          └── 🧬 点击 观测体 №001
                  ↓
              人类物种卡
```

> 核心主张：**桌宠本身就是 UI。** 摄像头、AI 识别、日志、历史记录、物种卡这些功能，都从桌宠身上展开，不做独立的 Dashboard 页面。

因此 A 的全部工作量压缩到四个视觉组件上：

| 编号 | 组件 | 作用 | 对应层级 |
|---|---|---|---|
| ① | 桌宠本体 `Pet` | 让它像一个活着的存在，并承载所有入口 | 第 1 层：桌宠 |
| ② | 观察气泡 `ObservationBubble` | 让它「现场记笔记」式地开口说话 | 第 2 层：观察气泡 |
| ③ | 观察日志抽屉 `LogDrawer` | 让行为变成记录，并逐渐形成研究手册 | 第 3 层：研究档案 |
| ④ | `观测体 №001` 物种卡 `SpeciesCard` | 完成 Aha Moment | 第 3 层：研究档案 |

### 0.3 统一接口协议（以 B 的协议为准，A 侧同源副本）

> 契约源在 B 手上，本节的字段与枚举必须与 B 保持同步；任何改动都要三人共同确认，不允许单方面改字段名。

**接口总览**

| 方向 | 接口 | 责任 |
|---|---|---|
| A → C | Camera Frame | A 提供画面，C 接收 |
| C → B | `POST /events`，提交识别出的行为 | C 提交，B 实现 |
| B → A | `POST /events` 的响应，供桌宠立即反应 | B 实现，A 使用 |
| B → A | `GET /observations` | B 实现，A 使用 |
| B → A | `GET /subjects/HUMAN_001` | B 实现，A 使用 |
| B → A | `GET /species-card` | B 实现，A 使用 |

**① A → C：Camera Frame**

摄像头画面 / 截帧图片。C 不关心 A 的桌宠长什么样。

**② C → B：`POST /events` 请求体**

```json
{
  "subject_id": "HUMAN_001",
  "event": "DRINKING",
  "confidence": 0.91,
  "timestamp": "2026-09-25T21:08:32+08:00"
}
```

- `event` 第一版限定为下 6 个值，不新增不自造：

```
PERSON_ENTER
DRINKING
STRETCHING
PERSON_LEFT
PERSON_RETURNED
UNKNOWN
```

- `confidence` 范围 `0 ~ 1`
- `timestamp` 统一用**带时区的 ISO 8601**（如 `+08:00`），避免三台机器记录的时间对不上

**③ B → A：`POST /events` 响应（A 的直接输入）**

```json
{
  "observation_id": 12,
  "event": "DRINKING",
  "pet_state": "CURIOUS",
  "message": "目标正在摄入透明液体……"
}
```

- `pet_state` 限定为下 7 个值，不新增不自造：

```
IDLE
OBSERVING
THINKING
CURIOUS
ALERT
EXCITED
CONFUSED
```

- **统一使用 `message` 字段。** 后端内部可以称它"外星研究员解释"，但给 A 的响应里只允许出现 `message`，不允许 `message` 与 `alien_interpretation` 两套名字并存。
- 字段一律 **snake_case**，不用 `petState` 这类驼峰写法。

**④ B → A：查询类接口**

| 接口 | A 用来做什么 |
|---|---|
| `GET /observations` | 填充观察日志抽屉 |
| `GET /subjects/HUMAN_001` | 累计行为计数（DRINKING × 4 等） |
| `GET /species-card` | 生成《观测体 №001 人类物种卡》 |

**开发端口约定**

三套服务统一跑在同一台机器上（A 的机器）：

| 服务 | 端口 |
|---|---|
| A（前端页面） | `3000` |
| B（后端 FastAPI） | `8001` |
| C（视觉识别） | `8002` |

A 侧不硬编码这两个地址，统一走环境变量（模板见 `frontend/.env.example`）：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:8001` | B 的 `POST /events`、`GET /observations` 等 |
| `NEXT_PUBLIC_VISION_URL` | `http://localhost:8002` | C 的 `POST /frame` |

**A 需要回传给 B / C 的确认项**

- [ ] 确认上述字段与枚举（`event` 6 个、`pet_state` 7 个、只用 `message`）
- [ ] 提供三人共用的 Git 仓库地址
- [x] 确认端口：A `3000`、B `8001`、C `8002`
- [x] 确认 A 与 B、C 的基础地址可配置（`.env.local`）

> A 的全部工作可以理解为：**把 Camera Frame 送出去，把 Observation 变成看得见的表演。**

### 0.4 A 明确不负责

❌ 人体识别 ❌ Pose Detection ❌ 动作分类 ❌ VLM ❌ 数据库

---

## 1. 步骤总览

| 步骤 | 名称 | 优先级 | 依赖 |
|---|---|---|---|
| Step 0 | 项目骨架与目录 | 必须 | — |
| Step 1 | 摄像头模块 | 必须 | Step 0 |
| Step 2 | 截帧与上报 | 必须 | Step 1 |
| Step 3 | 桌宠本体与状态机 | 必须 | Step 0 |
| Step 4 | 观察气泡 | 必须 | Step 3 |
| Step 5 | 状态映射层 | 必须 | Step 2 + Step 4 |
| Step 6 | 观察日志抽屉 | 必须 | Step 5 |
| Step 7 | 物种卡 | 必须 | Step 6 |
| Step 8 | Landing 与进入体验 | 必须 | Step 3 |
| Step 9 | Demo 编排与 Mock 模式 | 必须 | Step 5 |
| Step 10 | 打磨与演示兜底 | 加分 | Step 9 |

### 并行关系

```
Step 0
 ├→ Step 1 → Step 2 ─┐
 └→ Step 3 → Step 4 ─┼→ Step 5 → Step 6 → Step 7
                     │
                     └→ Step 8 / Step 9 → Step 10
```

Step 1–2（相机侧）与 Step 3–4（表演侧）**可以先并行**，Step 5 才真正汇合。

---

## 2. 各步骤详细定义

### Step 0 — 项目骨架与目录

**目标**：搭好 A 独占的工程地基，保证后续所有提交不碰别人的目录。

**实现内容**

- Next.js + React + TypeScript + Tailwind CSS 初始化
- 建立 A 的目录结构：

```
frontend/
├── components/
│   ├── Pet/
│   ├── ObservationBubble/
│   ├── LogDrawer/
│   └── SpeciesCard/
├── features/
│   └── camera/
├── hooks/
│   ├── useCamera.ts
│   └── usePetState.ts
├── lib/
│   └── api.ts
└── types/
```

- 在 `types/` 中落地契约类型：`Observation`、`PetState`、`HumanEvent`
- 建立 API 层 `lib/api.ts`（统一请求出口，不散落在组件里）

**验收**：项目能跑起来，空页面可访问，`PetState` 枚举与 B、C 完全一致。

**可替换点**：脚手架生成方式、样式方案。

---

### Step 1 — 摄像头模块

**目标**：让桌宠拥有“眼睛”，稳定拿到摄像头流。

**实现内容**

- 封装 `useCamera.ts`，基于 `MediaDevices API / getUserMedia()`
- 请求权限 → 获取 Camera Stream → 绑定到视频元素
- 支持**显示 / 隐藏摄像头预览画面**（演示时可选择不露画面）
- 完整状态管理，逐个处理：

```
permission denied
camera unavailable
loading
capture failure
```

- 页面与相机的生命周期绑定：进入即请求、离开即释放

**验收**：点击「开启摄像头」能看到画面；拒绝权限时不崩溃且有明确引导；关闭页面后摄像头指示灯熄灭。

**可替换点**：相机 Hook 库、权限引导组件。

---

### Step 2 — 截帧与上报

**目标**：把画面交给 C，拿到行为事件。

**实现内容**

- 从视频流截取帧并转成约定的图片格式
- 节流 / 降采样（避免高帧率无意义上传）
- 按约定把 Frame / Image 交给 C 的识别入口（A 只负责送画面，**不做任何识别**）
- 上报链路对接：画面交给 C 后，由 C 调 `POST /events`；A 侧监听 **B → A** 的响应
- 字段严格按 [0.3 统一接口协议](#03-统一接口协议以-b-的协议为准a-侧同源副本)，不做任何 rename
- 处理异常分支：请求超时、请求失败、响应字段缺失 / 格式异常

**验收**：能稳定地把一帧交给下游，并在日志 / 控制台看到完整往返。

**注意边界**：只在需要分析时截帧；Demo 阶段不长期保存原始摄像头画面。

**可替换点**：截帧工具、上传封装、轮询 / WebSocket 方案。

---

### Step 3 — 桌宠本体与状态机 ✅ 已实现

**目标**：让屏幕角落的像素桌宠“活着”，并且**一眼就能看出它在干什么**。

**实现内容**

- `Pet` 组件：基于像素精灵图集 `boxcat.webp` 渲染（1536×1872，8 列 × 9 行，单格 192×208，共 72 帧，`image-rendering: pixelated`）。
  形象是 boxcat 像素猫；世界观里它仍自称「外星研究员」，文案层不变，只是**渲染层从手绘 SVG 换成了开源像素图集**。
- 图集 9 行（row 0~8）：`idle / running-right / running-left / waving / jumping / failed / waiting / running / review`
- 各行实际帧数 **`[6,8,8,4,5,8,6,6,6]`**，逐行播放用「帧数自适应」的 CSS `steps()` 关键帧驱动（**不硬编码 8**），切行改 `background-position-y`
- 头顶道具用与图集同一逻辑网格的 **canvas overlay** 画布（192×264，向上多 56px 留白），与图集格嵌套叠加
- 同一套图集复用全部 7 个 `pet_state`，用 `data-pet-state` 属性 + CSS 类选图集行 + 体态动画 + 头顶道具，
  **每个状态 = 专属动作 + 专属道具**，保证「手动切换时差异明显」：

```
IDLE        发呆        idle 行逐帧；体态 bob 上浮 2.8s
OBSERVING   观察中      idle 行逐帧；体态 lean 前倾 3.6s；头顶像素双筒望远镜（340ms 过冲弹出 + 两只猫爪握持）
THINKING    记录中      「记录动画」时间线（4040ms，替代逐帧）：待机 → 冒出「!」→ 掏笔记本 → 翻开 →
                       飞速写（像素笔摆动 + 像素烟）→ 收起 → 待机
CURIOUS     好奇        waving 行逐帧；体态 crane 歪头 3.4s
ALERT       警戒        running 行逐帧；头顶大「!」1400ms 慢闪 + 2px 轻浮动
EXCITED     发现新行为   jumping 行逐帧；体态 jump 1.5s；5 道星芒 + 每 3000ms「突然点亮」的像素小灯泡
CONFUSED    困惑        waiting 行逐帧；体态 wobble 3.6s；3 个大小不一的「?」慢飘
```

- 待机动画循环：即使没有事件，IDLE 也自带逐帧呼吸感，画面不会“死”
- 自适应尺寸：外层按 `288:380` 定比例，内层固定 288×380，由 `ResizeObserver` 量宽后整体 `transform: scale()`，放进任意容器宽度都不变形
- 状态切换的过渡：切状态即重启对应 CSS `keyframes`；头顶道具每帧重绘，进入 / 退出都有缓动（望远镜过冲弹出、灯泡缓灭）
- 无障碍：整块 `role="img"` + 按状态生成的 `aria-label`；`prefers-reduced-motion` 下不启动动画循环，只画一帧静态造型（THINKING 停在「飞速写」那一帧）

**验收**：无人时宠物自主活动；手动切换 `pet_state` 时能看到明显不同的表现。（预览页：`/pet-preview`）

**可替换点**：① 渲染层与状态层已解耦——换素材只需替换 `boxcat.webp` 与 `STATE_SPEC` 映射表，`pet_state` 这个对外契约不变。（本次已采用 GitHub 开源像素宠物图集方案落地）

---

### Step 4 — 观察气泡

**目标**：让宠物能说话，并且话说得像“外星研究员”——**是「桌宠现场记笔记」，不是「系统弹提示」**。

**实现内容**

- `ObservationBubble` 组件：气泡 UI + 文本展示，定位在**桌宠头顶**，像它自己掏出本子记下来
- 打字机式逐字呈现（强化“正在汇报”的感觉）
- 台词来自 B 的 `message`，A 不生成文案
- **几秒后自动收回**（观察行为发生时自动弹出，无需用户操作，也不打断用户）
- 多条排队 / 避免遮挡桌宠
- 不同语气对应不同视觉（普通观察 / 警戒 / 发现）
- 文案语气对齐世界观：写“观察记录”，不写“AI 识别结果”（如「观测体 №001 摄入透明液体」而不是 `detected: drinking water`）

**验收**：给定任意 `message`，能完整、优雅地展示并自动收尾；连续多条不打架。

**可替换点**：打字机效果库、队列与动画方案。

---

### Step 5 — 状态映射层（核心枢纽）

**目标**：把 B 的 `Observation` 翻译成桌宠的完整表演。**这是 A 所有工作真正汇合的地方。**

**实现内容**

- `usePetState.ts` 统一入口，负责接收 `Observation`
- 收到后一次性触发三件事：

```
Observation
   ↓
① 切入对应 pet_state，播放动画
② 弹出观察气泡
③ 追加一条 Observation 到日志
```

- 状态优先级与并发处理（如 `ALERT` 不被普通观察打断）
- 状态自动回落（如 `EXCITED` 一段时间后回到 `OBSERVING` / `IDLE`）
- 无事件时的默认状态兜底

**验收**：给一条 `{ event: "DRINKING", pet_state: "CURIOUS", message: "..." }`，桌宠动画、气泡、日志三处同时正确发生。

**可替换点**：状态机库（如通用状态管理 / 动画状态机方案）。

---

### Step 6 — 观察日志抽屉

**目标**：让一次性的动作变成连续性的记录，并且它读起来像**外星生物学家的田野调查笔记 / SCP 档案 / 宝可梦图鉴**，而不是普通 Dashboard。

**实现内容**

- `LogDrawer` 组件：点击桌宠旁边的 📓 后，**从屏幕右侧滑出**的抽屉
- 抽屉标题栏走世界观包装（不出现“检测结果”“置信度 0.92”这类裸技术信息）：

```
XENO RESEARCH DATABASE
HUMAN OBSERVATION LOG

SUBJECT: 观测体 №001
STATUS:  ACTIVE
OBSERVATION TIME: 00:17:32
```

- 正文是**观察记录**，不是 AI 识别结果。每条包含：时间、观察描述、当前假说、置信度条：

```
21:03
观测体 №001 摄入透明液体
当前假说：人类需要定期补充液体以维持内部系统稳定
置信度：████████░░ 82%
```

- 观察越久，日志逐渐形成一本「人类研究手册」（养成感）：

```
观察记录 → 行为归类 → 形成假说 → 更新 观测体 №001 档案
```

- 展示 `观测体 №001` 的累计数据（行为归类结果）：

```
观测体 №001
💧 液体摄入           × 4
🧘 肢体伸展           × 2
🚶 离开观察区域        × 1
```

- 数据来源：`GET /observations`、`GET /subjects/HUMAN_001`
- 新事件进入时的视觉反馈与自动滚动

**验收**：完成喝水、伸懒腰、离开后，抽屉里能正确显示三条观察记录与对应计数。

**可替换点**：抽屉 / 时间线类 UI 组件。世界观包装文案若后端未下发，可由 A 侧在展示层做一层映射（`event` → 观察描述模板），但**不得改动契约字段名**。

---

### Step 7 — 物种卡（Aha Moment）

**目标**：把整场演示推向认知反转。

**实现内容**

- `SpeciesCard` 组件：`观测体 №001` 人类物种卡，是整场演示的高潮与答辩截图
- 触发方式：点击桌宠旁的「🧬 观测体 №001」→ 桌宠先**疯狂敲键盘（切到 `THINKING`）**→ 卡片浮现
- 卡片字段（星级由 `event_counts` 映射，文案来自 `summary`）：

```
       观测体 №001
    [ 摄像头抓拍照片 ]
  Species     Human (?)
  Threat      ★★☆☆☆
  Activity    ★★★☆☆
  Hydration   ★★★★☆

  DISCOVERED BEHAVIORS
  💧 Liquid Consumption  × 4
  🧘 Body Expansion      × 2
  🚶 Escape Attempt      × 1

  RESEARCHER NOTE
  “该生物会周期性摄入液体，并长时间
   凝视发光矩形。暂未发现明显智慧迹象。”

       👽 CLASSIFIED
```

- 字段与契约的对应关系（不改契约）：
  - `subject_id` → 标题固定渲染为 `观测体 №001`
  - `event_counts` → `DISCOVERED BEHAVIORS` 计数 + `Threat / Activity / Hydration` 星级
  - `summary` → `RESEARCHER NOTE`
- 生成过程要有仪式感：数据汇聚 → 逐个字段浮现 → 星级逐颗点亮 → 结论落定 → `CLASSIFIED` 盖章
- 最终定格画面：

> **「你养的电子宠物，其实一直在研究你。」**

- 数据来源：`GET /species-card`

**验收**：点击生成后，卡片按设计节奏呈现，最后一帧能独立截图用于答辩。

**可替换点**：卡片动画、数字滚动效果、导出为图片的方案。

**模块选型（本次）**

- **卡片动画 / 仪式感容器**：`guokaigdg/animal-island-ui`（已在前序步骤使用，当前锁定 `1.13.0`）
  - `Modal`（`variant="game"` 异形自然外框）承载整张物种卡，负责「浮现 → 落定 → 盖章」的入场节奏
  - ⚠️ `Modal` 内置打字机（`typewriter` 默认 `true`、`typeSpeed` 默认 80ms），物种卡的字段要按设计节奏逐条浮现，须显式传 `typewriter={false}` 自行控时
  - `Card`（`pattern` / `color` 走档案纸质感）承载 `DISCOVERED BEHAVIORS` 与 `RESEARCHER NOTE` 分块；`hoverable` 仅带来 `cursor:pointer + translateY(-2px)`，静态展示用默认 `false`
  - 与 `Drawer` 同源的 SSR 约束：`Modal` 走 portal，必须 `next/dynamic` + `ssr:false` 挂载；库内 CSS 为 unlayered，同元素上的 Tailwind 字号 / 颜色会被覆盖，需用 inline style
- **数字滚动**：`NumberFlow`（`barvian/number-flow`，React 包名 **`@number-flow/react`**，零依赖，MIT）
  - 用于 `event_counts` 的计数展示（`× 4`、`× 2`、`× 1`）：数字逐位滚动（odometer 风格），比直接出现更有「正在计算」的感觉，配合圆润字体更萌
  - 用法：`import NumberFlow from "@number-flow/react"` → `<NumberFlow value={4} />`，可用 `prefix` / `suffix`（如 `suffix="次"`）、`spinTiming` 调滚动节奏；默认 `respectMotionPreference` 尊重 reduced-motion
  - 计数与星级仍由 `event_counts` 映射，**不改契约字段名**
  - 可选：`Countdown` 组件（同库，`variant="island"`）用于「今日观察时间」，与 `NumberFlow` 二选一即可

---

### Step 8 — 进入体验与桌面布局

**目标**：把评委从“打开页面”带到“它注意到我了”，并且**全程只有一个界面——桌面本身**。

**实现内容**

- 进入体验只承担一件事：**授权摄像头**。不做多页面跳转：

```
电脑桌面（唯一界面）
     ↓
👽 桌宠常驻右下角，处于待机 / 陪伴状态
     ↓
有人靠近 → 桌宠抬头：「它注意到我了。」
```

- 「开始体验」→ 请求摄像头权限 → 桌宠出现在桌面角落
- 布局为**单屏桌面**，不放 Dashboard：
  - 桌宠：常驻角落，不遮挡工作区
  - 观察气泡：从桌宠头顶弹出，几秒后自动收回
  - 📓 与 🧬 两个入口长在桌宠身上 → 分别展开日志抽屉 / 物种卡
  - 摄像头预览默认**可隐藏**（演示时可选择不露画面）
- 首次进入的引导：一句提示，不超过一行

**验收**：从打开页面到桌宠进入等待状态，全程无需任何解释，评委自己能走完；桌面上的任何功能都从桌宠身上展开，不出现“另一个网站”。

**可替换点**：权限引导组件、桌宠的出现方式（淡入 / 从屏幕边缘滑入）。

---

### Step 9 — Demo 编排与 Mock 模式

**目标**：保证 3 分钟演示可控、可重复、不翻车。

**实现内容**

- **Mock 模式开关**：不接 C / B 也能完整播放整条链路
- 内置与 B、C 约定一致的标准事件序列：

```
PERSON_ENTER → DRINKING → STRETCHING → PERSON_LEFT → PERSON_RETURNED
```

- Mock 数据必须使用 `event`（6 个枚举，含 `UNKNOWN`）、`pet_state`（7 个枚举）、`message`、`observation_id` 的正式字段名，**不得出现 `petState`、`action`、`alien_interpretation` 等非契约字段**

- **一键演示模式**：按剧本时间轴自动触发，主持人不操作也能跑完
- 支持手动模式：真人靠近摄像头由真实识别触发
- 演示前自检：相机可用性、接口连通性
- 兜底：任一环节失败时自动降级到 Mock，保证 Demo 一定演得完

**验收**：断网 / 无摄像头 / AI 未就绪时，Demo 依然能完整演示并被评委看懂。

> 这一步是 A 对项目最大的保险。**先用假 AI 打通完整链路，再替换成真 AI。**

**可替换点**：演示模式实现方式（本地脚本 / 配置驱动）。

---

### Step 10 — 打磨与演示兜底（加分）

**目标**：从“能跑”到“像一个产品”。

**实现内容**

- 音效：发现、警戒、结论落定
- 转场与氛围：深色科幻风、扫描线、微光
- 宠物与明文分层，保证字幕在投屏上可读
- 低配降级：性能不足时降低动画帧率而不掉功能
- 演示环境适配：分辨率、投屏比例、窗口尺寸
- 答辩用的固定截图 / 录屏素材准备

**验收**：投影仪上文字清晰、动画流畅、全程无卡顿与白屏。

**可替换点**：音效 / 视觉资源、性能监控方案。

---

## 3. A 的完成定义（DoD）

A 部分完成的标准不是“页面做完了”，而是这一整条表演成立：

```
评委打开页面
   ↓
点击「开始体验」，授权摄像头
   ↓
屏幕里有一只活着的桌宠在等待
   ↓
有人靠近摄像头
   ↓
桌宠抬头 —— 「它注意到我了。」
   ↓
喝水 / 伸懒腰 / 离开，每次都有解释与记录
   ↓
展示《人类观察日志》
   ↓
生成《观测体 №001 人类物种卡》
   ↓
「你养的电子宠物，其实一直在研究你。」
```

**A 的一句话职责**：

> 让它像一个产品。
