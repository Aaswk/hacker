# 人类观察站 · 使用说明

> 一个把**摄像头里的人类**当成外星物种来观察的桌宠。
> 它用 Pose 认出你的进出、伸展、喝水，用 VLM 给「喝水」这种模糊动作下判决，
> 然后由桌宠用外星研究员的语气把这件事念出来。
>
> **Aha Moment**：你在镜头前喝一口水 → 桌宠歪头看向你：「目标正在为内部海洋补充液体。」

本文档是**跑起来 + 用起来 + 排错**的手册。设计背景与分工契约见文末【文档索引】。

---

## 1. 系统组成

四个组件，三个进程间接口（全部是 HTTP，没有消息队列 / 没有数据库中间件）：

```
  摄像头
    │
    ▼
  C  vision/          python3 -m vision.main   （本机摄像头 / RTSP / 视频文件）
     MediaPipe Pose ──▶ 人物进出 / 伸懒腰 / 疑似喝水
                          └─ 疑似喝水 ──▶ 截 3 张关键帧 ──▶ VLM(qwen-vl-plus) 裁决
                          └─ 统一成事件 JSON（event_manager，固定 HUMAN_001）
    │
    │  POST /events
    ▼
  B  app.py           FastAPI + SQLite         127.0.0.1:8001
     /events 落库 + 按 NARRATIVE 映射 pet_state / message
     /observations · /subjects/{id} · /species-card · /health
    │
    │  GET /observations（2s 轮询）
    ▼
  A  frontend/        Next.js 16               localhost:3000
     / 桌面体验    /live 联调    /pet 透明桌宠页    /pet-preview 预览
       ▲
       │ 加载 http://localhost:3000/pet
     desktop/   Electron 壳（透明 / 无边框 / 置顶 / 点击穿透）
```

**接口只有三条，记住这三条就能看懂整个项目：**

| # | 方向 | 接口 | 说明 |
| --- | --- | --- | --- |
| 1 | C → B | `POST /events` | C 识别到事件后**自己**提交给 B，A 不参与 |
| 2 | A ← B | `GET /observations` | 前端 2s 轮询，拿 `pet_state` + `message` 驱动桌宠和气泡 |
| 3 | A → C | `POST /frame`（8002） | 送帧契约**已定义但尚未接线**，见《A交付C说明.md》 |

> 分工铁律：**A 只送画面不做识别；A 不替 C 提交 B；C 的 `/frame` 响应不是 `Observation`。**

### 端口占用一览

| 端口 | 谁 | 进程 |
| --- | --- | --- |
| `8001` | B 后端 | `uvicorn app:app` |
| `3000` | 前端 | `npm run dev`（Next） |
| `8002` | C 的 `/frame` | **当前未实现**，C 现在直接读本机摄像头，不需要前端送帧 |
| — | 桌宠 | Electron 壳，加载 `localhost:3000/pet` |

---

## 2. 环境要求

| 依赖 | 版本 | 用途 | 备注 |
| --- | --- | --- | --- |
| Python | 3.11+（B） / 3.9+（C） | B 后端、C 视觉 | 两者建议**分开的 venv** |
| Node.js | 20+ | 前端、Electron 壳 | 桌面壳用 `electron@44` |
| 摄像头 | — | C 的图像来源 | macOS 需在「系统设置 → 隐私与安全性 → 摄像头」里授权**终端 / iTerm** |
| 网络 | — | 调 VLM | 喝水裁决走阿里云百炼 OpenAI 兼容接口 |

> 本机（macOS, Apple Silicon）的既有装法：B 用仓库根 `.venv`；C 的 mediapipe/opencv/numpy
> 装在系统 `python3`（Command Line Tools 3.9）里 —— `scripts/dev-up.sh` 就是按这个假设写的。
> 换机器请按第 4.3 节单独给 C 建 venv，并把脚本里的 `python3` 换掉。

---

## 3. 快速开始

### 3.1 一键启动（推荐）

```bash
cd /Users/syyz/hacker

# 第一次：准备密钥（不填也能跑，只是「喝水」识别不出结果）
cp .env.example .env
$EDITOR .env                      # 填 VLM_API_KEY=sk-xxxxxx

./scripts/dev-up.sh               # 后端 → 前端 → 视觉(VLM) → 桌宠
./scripts/dev-down.sh             # 全部停掉
```

`dev-up.sh` 会按顺序拉起四个组件并做健康检查，最后打印：

```
== 状态 ==
  /      HTTP 200
  /live  HTTP 200
  /pet   HTTP 200
  观察记录：{"subject_id":"HUMAN_001","event_counts":{...},"summary":"已记录 N 次观察。..."}
```

- 日志：`/tmp/human-observatory/logs/{backend,frontend,vision,pet}.log`
- PID：`/tmp/human-observatory/{backend,frontend,vision,pet}.pid`
- **幂等**：已经在跑的组件会被跳过（看 pid 文件判断），放心重复执行
- `dev-down.sh` 三重兜底停服：pid 文件 → 端口(3000/8001) → 进程特征，手工起的进程也能清掉

### 3.2 手工分步启动（想单独调试某个组件时）

```bash
# ① B 后端（终端 1）
cd /Users/syyz/hacker
.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8001

# ② 前端（终端 2）
cd /Users/syyz/hacker/frontend
npm install          # 首次
npm run dev          # → http://localhost:3000

# ③ C 视觉 + VLM（终端 3）—— 注意 </dev/null，见 5.3 节
cd /Users/syyz/hacker
python3 -u -m vision.main

# ④ 桌宠（终端 4，可选）
cd /Users/syyz/hacker/desktop
npm install          # 首次
npm run pet
```

### 3.3 只跑 C 的视觉（不启前端 / 桌宠）

只验证「摄像头 → 识别 → 落库」这条链路，看终端日志就够：

```bash
python3 -u -m vision.main                 # 本机摄像头
python3 -u -m vision.main --source /path/to/video.mp4    # 离线视频回放
python3 -u -m vision.main --source http://<手机IP>:8080/video   # 用手机当摄像头（见 6.5）
```

`vision.main` 的预览窗口里按 `q` / `ESC` 退出，或终端 `Ctrl+C`。
不想占用前置摄像头 / 想拿手机当眼睛，从 **6.5 节**开始看。

---

## 4. 配置

### 4.1 `.env`（根目录，**含密钥，已在 `.gitignore` 里**）

`vision` 包被导入时自动加载（`vision/dotenv.py`，零依赖）。优先级：**shell export > `.env.local` > `.env`**。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `VLM_API_KEY` | 空 | **喝水裁决必填**；没有它喝水检测直接返回 `NONE`，其余功能照常 |
| `VLM_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | VLM 的 OpenAI 兼容地址 |
| `VLM_MODEL` | `qwen-vl-plus` | 也可换 `qwen3-vl-plus` / `qwen-vl-max`（需账号有权限） |
| `VLM_TIMEOUT` | `15` | 单次 VLM 请求超时（秒） |
| `BACKEND_BASE_URL` | 空 | B 的地址，如 `http://localhost:8001`；**不填则只打日志、不发请求** |
| `BACKEND_TIMEOUT` | `5` | 发给 B 的请求超时（秒） |
| `OBSERVATION_DB` | `observations.sqlite3` | B 的落库文件位置（相对 `app.py` 同目录） |

> 仓库里只有不含密钥的 `.env.example`。**密钥不要提交、不要发群里。**

### 4.2 前端环境变量（`frontend/.env.local`，可选）

`NEXT_PUBLIC_*` 在**编译期内联**，改完必须重启 dev server。

| 变量 | 默认 |
| --- | --- |
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:8001` |
| `NEXT_PUBLIC_VISION_URL` | `http://localhost:8002` |

想让**手机浏览器**打开前端时，这两个值必须是 Mac 的局域网 IP（手机会把 `localhost` 理解成手机自己）——
不用手改，用 `LAN=1 ./scripts/dev-up.sh` 启动会自动设好，见 **6.6 节**。

### 4.3 C 的独立 venv（换机器 / 想隔离时）

mediapipe 和 B 的 FastAPI 依赖版本会互顶，**不要混装**：

```bash
python3 -m venv .venv-vision
.venv-vision/bin/pip install -r vision/requirements.txt
.venv-vision/bin/python -m vision.main
# 国内装不动就加镜像：
#   -i https://pypi.tuna.tsinghua.edu.cn/simple
```

`vision/requirements.txt` = `mediapipe==1.0.1` / `opencv-python==4.10.0.84` / `numpy==1.26.4`。
**只跑 VLM 联网探针不需要这些依赖**（零第三方库，系统 python3 就能跑）。

---

## 5. 你会看到什么（验收 / 演示脚本）

### 5.1 演示三连

| 你做什么 | 桌宠说什么（`message`） | `event` | `pet_state` |
| --- | --- | --- | --- |
| 走进镜头 | 检测到未知碳基生命体。开始建立观察档案。 | `PERSON_ENTER` | `EXCITED` |
| **喝一口水** ⭐ | **目标正在为内部海洋补充液体。** | `DRINKING` | `CURIOUS` |
| 双手举过头顶伸懒腰 | 目标正在扩大身体面积，原因有待观察。 | `STRETCHING` | `ALERT` |
| 离开镜头 | 观察对象离开了视野。 | `PERSON_LEFT` | `ALERT` |
| 再回来 | HUMAN #001 再次出现。 | `PERSON_RETURNED` | `EXCITED` |
| 看不出是什么动作 | 记录到尚未理解的行为。 | `UNKNOWN` | `CONFUSED` |

> 这张表就是 B 里 `NARRATIVE` 字典的原文（`app.py`）。同一 `event` 的文案是**固定**的 ——
> 想「同事件不同说法」需要改 B 侧生成逻辑（A 侧只读 `message`、不改写）。

**喝水的完整链路**（演示时最值得讲的一条）：

```
① 手腕贴近嘴部 5 帧（--drink-trigger-frames，防抖）
② 截 3 张关键帧（--drink-keyframes）
③ 送 qwen-vl-plus：这是「喝水」还是只是「摸脸 / 擦嘴」？
   ├─ DRINKING → POST /events → 201 → B 落库 → 前端轮询 → 桌宠歪头说话
   └─ NONE     → 只打日志，不打扰 B（Pose 只是「疑似」，VLM 才是裁判）
```

### 5.2 手动确认「事件真的落库了」

```bash
curl -s http://127.0.0.1:8001/species-card | python3 -m json.tool     # 各事件累计次数
curl -s http://127.0.0.1:8001/subjects/HUMAN_001 | python3 -m json.tool
curl -s http://127.0.0.1:8001/observations | head -c 600              # 最近记录（倒序）

sqlite3 /Users/syyz/hacker/observations.sqlite3 \
  "select id,event,confidence,pet_state,message from observations order by id desc limit 5;"
```

### 5.3 ⚠️ 后台跑 C 必须把 stdin 接到 `/dev/null`

```bash
nohup python3 -u -m vision.main </dev/null > /tmp/vision.log 2>&1 &
```

macOS 上 OpenCV 的 `cv2.waitKey` 会读到**启动它的那个终端**里输入的字符，而 `q`/`ESC`（113/27）
正好是本模块的退出键 —— 结果是：**终端里随便敲点东西，预览窗口自己退出了**，
日志里只留一行 `[exit] 收到退出按键`。`nohup` **不会**替你摘掉 stdin，必须显式重定向。
`scripts/dev-up.sh` 已经处理了这一条。

---

## 6. 组件说明

### 6.1 B：后端（`app.py`，端口 8001）

```bash
.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8001
# 交互式文档：http://127.0.0.1:8001/docs
```

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | `{"status":"ok"}`，启动探活用 |
| `POST` | `/events` | **201**，落库 + 映射叙事，返回 `observation_id` / `pet_state` / `message` |
| `GET` | `/observations` | 全部观察记录，按 `id` 倒序 |
| `GET` | `/subjects/{subject_id}` | `total_observations` + `event_counts` |
| `GET` | `/species-card` | 物种卡：事件计数 + 一句 `summary` |

**`POST /events` 请求体（契约很严）**：

```json
{
  "subject_id": "HUMAN_001",
  "event": "DRINKING",
  "confidence": 0.9,
  "timestamp": "2026-09-26T16:19:25+08:00"
}
```

| 字段 | 约束 | 违反时 |
| --- | --- | --- |
| `subject_id` | **只接受 `HUMAN_001`**（MVP 单主体） | 422 |
| `event` | 6 枚举：`PERSON_ENTER` `DRINKING` `STRETCHING` `PERSON_LEFT` `PERSON_RETURNED` `UNKNOWN` | 422 |
| `confidence` | `0 ≤ x ≤ 1`，不许 NaN / Inf | 422 |
| `timestamp` | **必须带时区**的 ISO 8601 | 422 |

`pet_state` 是 7 枚举：`IDLE` `OBSERVING` `THINKING` `CURIOUS` `ALERT` `EXCITED` `CONFUSED`。

- 存储：SQLite 单表 `observations`（自动建表），默认 `app.py` 同目录的 `observations.sqlite3`，
  可用 `OBSERVATION_DB` 改。
- CORS：只放行 `http://localhost:3000` 与 `http://127.0.0.1:3000`（前端换端口要同步改这里）。
- 后端**不做去重**：同一动作重复上报就会重复落库，去抖由 C 负责。

### 6.2 A：前端（`frontend/`，端口 3000）

```bash
cd frontend
npm install
npm run dev            # http://localhost:3000
```

| 路由 | 是什么 | 数据来源 |
| --- | --- | --- |
| `/` | **单屏桌面体验（主入口）**：萌系摄像头授权卡 → 桌宠常驻，📓 / 🧬 悬停浮现 | 轮询 B（`usePetState`） |
| `/live` | **联调页**：手动「开始观察」、Mock `POST /events`、宠物状态调试控件 | 轮询 B |
| `/pet` | **透明桌宠页**：全透明无背景，供 Electron 壳加载；每 120ms 上报命中矩形 | 轮询 B（独立一份） |
| `/pet-preview` | **纯预览页**：7 状态按钮 / 全景 / 连发 3 条，**不接 B** 的本地小剧场 | `usePetBehavior` 本地台词池 |

```bash
npm run check:b        # B 接口契约自检（只读接口，不写数据）
npm run check:c        # C 的 /frame 送帧契约自检
npm run lint
npm run build && npm start
```

其他要点：

- `/` 的摄像头**不做画面预览**：授权后 `video` 变成 1px 隐藏元素（刻意不用 `display:none`，
  否则浏览器可能不渲染帧、抓不到画面），截帧链路保留；`/pet` 桌面版**完全不带摄像头**。
- 前端对 B 的响应逐字段校验（`lib/api.ts` 的 `isObservation`），字段不符只 `console.warn`、
  不崩页面；新记录按 `observation_id` 增量识别。
- 桌宠有**本地小剧场兜底**（「主动检测」：久坐预警 / 互动意愿指数等），这是 C 上线前的
  占位实现；C 有事件时以 B 下发的 `message` 为准。

### 6.3 C：视觉 + VLM（`vision/`）

```bash
python3 -u -m vision.main [选项]
```

**视频源**（`--source` 优先于 `--camera`）：

| 写法 | 含义 |
| --- | --- |
| 不填 / `--camera 0` | 本机摄像头，默认 0 号 |
| `--source 1` | 摄像头 index 1 |
| `--source rtsp://user:pass@ip:554/stream` | RTSP 网络摄像头 |
| `--source http://ip:8080/video` | HTTP-MJPEG 流 |
| `--source /path/to/video.mp4` | 本地视频文件（**离线回放，演示视频首选**） |

**全部参数**（等价于 `python3 -m vision.main --help`）：

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| `--width` / `--height` / `--fps` | `640` / `480` / `30` | 采集分辨率与期望帧率 |
| `--model` | `models/` 下的内置 `.task` | Pose 模型文件路径 |
| `--num-poses` | `1` | 最多检测几个人 |
| `--min-detection-confidence` | `0.5` | 人体检测置信度阈值 |
| `--no-mirror` | 关 | 关闭镜像（默认像照镜子） |
| `--show-raw` | 关 | 额外弹原始画面窗口，方便与标注画面对比 |
| `--debug-labels` | 关 | 每个关键点标名字（很乱，仅排查用） |
| `--stable-frames` | `8` 帧 | 连续多少帧检测到人才算「真的来了」（防抖，约 0.27s@30fps） |
| `--absent-timeout` | `2.0` s | 连续丢失多久才算「真的走了」（触发 `PERSON_LEFT`） |
| `--stretch-hold` | `0.6` s | 双手举过头顶持续多久算伸懒腰 |
| `--stretch-cooldown` | `5.0` s | 两次 `STRETCHING` 的最小间隔 |
| `--drink-trigger-frames` | `5` 帧 | 连续多少帧「疑似喝水」才触发一次 VLM 调用（防抖） |
| `--drink-cooldown` | `15.0` s | **两次 VLM 调用的最小间隔**（对 `DRINKING` 与 `NONE` 都生效） |
| `--drink-trigger-distance` | `0.30` | 手腕到嘴部的最大归一化距离（**刻意宽松**，交给 VLM 裁决） |
| `--drink-keyframes` | `3` | 每次送给 VLM 的关键帧张数（1~3，**直接影响 token 消耗**） |

**省 token 的推荐跑法**（长时间挂着演示时）：

```bash
python3 -u -m vision.main --drink-cooldown 60 --drink-keyframes 1
```

> 实测：默认 15s 冷却下，人坐在镜头前手靠近口部会反复命中 Pose 启发式，
> 3 分钟发起了 5 次 VLM 调用（每次 3 张图）。短演示要「秒回」就保持默认；
> 长时间挂机请把冷却调大、关键帧减到 1。

**退出**：预览窗口按 `q` / `ESC`，或终端 `Ctrl+C`；后台跑见 5.3 节。

**结构**（各文件职责）：

```
vision/
  video_source.py           统一视频源（摄像头 / RTSP / HTTP-MJPEG / 本地文件）
  pose_detector.py          MediaPipe Pose 关键点
  presence_detector.py      人物进出 / 离开 / 回来
  stretching_detector.py    伸懒腰
  drinking_vlm_detector.py  喝水：Pose 疑似 → 截关键帧 → VLM 裁决（后台线程）
  vlm_client.py             OpenAI 兼容 /chat/completions 客户端（纯标准库）
  dotenv.py                 零依赖 .env 加载器
  event_manager.py          统一事件 JSON（固定的 subject_id = HUMAN_001）
  event_sender.py           异步 POST 到 B 的 /events
  main.py                   串流程的演示入口
```

### 6.4 桌宠：Electron 壳（`desktop/`）

```bash
cd desktop
npm install          # 首次
npm run pet          # = electron .

# 前端换了端口时覆盖加载地址：
PET_URL="http://localhost:3001/pet" npm run pet
```

- 窗口**铺满主显示器工作区**（不含任务栏）：透明 / 无边框 / 置顶 / 不进任务栏，
  所以桌宠能在整屏被拖动「溜达」，默认停在中下方（水平居中、离底约 56px）。
- **透明区域鼠标穿透**：命中判定在主进程（系统光标坐标 + 渲染层上报的 `[data-pet-hit]` 矩形），
  只有光标压在桌宠本体 / 按钮 / 弹层面板上时窗口才吃事件 —— **桌面其余区域的点击不被挡**。
- **交互**：单击 = 戳一戳；长按 180ms 后拖动 = 给桌宠换位置；右键 = 「显示/隐藏气泡」+
  「🚪 退出桌宠」；鼠标靠近桌宠才浮现 📓（观察日志）/ 🧬（物种卡）入口。
- **逃生快捷键**（万一窗口「看得见但点不到」）：

| 快捷键 | 作用 |
| --- | --- |
| `Cmd/Ctrl+Shift+Alt+R` | 强制重载渲染层 |
| `Cmd/Ctrl+Shift+Alt+Q` | 退出桌宠（**只退 Electron 壳，不影响 C 的视觉进程**） |

- 渲染层崩溃 / 无响应会自动 `reload()`（10s 冷却，不会死循环）；
  前端没起时窗口会打印「先启动前端 dev server」而不是白屏。

### 6.5 用 iPhone 当 C 的视频源（零代码）

**不需要改任何代码**：`vision/video_source.py` 已支持 摄像头 index / `rtsp://` / `http(s)://`(MJPEG) / 本地文件，
所以「iPhone 当眼睛」只是**给 `--source` 填对值**的问题。两条路：

#### 路线 A：连续互通相机（iPhone 直接变成 Mac 的摄像头）

1. iPhone：**设置 → 通用 → 隔空播放与连续互通 → 连续互通相机** 打开；
2. iPhone 与 Mac：同一 Apple ID、Wi-Fi 与蓝牙都开，iPhone 解锁并靠近 Mac；
3. 确认 Mac 认到了它（应多出「iPhone 的摄像头」条目）：

```bash
system_profiler SPCameraDataType | grep -i iphone
```

4. 找出它的 index（**必须用脚本**，见下）：

```bash
python3 scripts/camera-probe.py --indices 1 2 3 4      # 避开正被 C 占用的 0
```

5. 让 C 用它：

```bash
python3 -u -m vision.main --camera <那个 index>
```

> index **会随连接状态变化**（插拔、iPhone 锁屏、切换 Mac 摄像头都会变），macOS 界面上也不标序号 ——
> 这就是需要探测脚本的原因。

> ⚠️ **本机实测（2026-09-26）：路线 A 还有一道 macOS 侧的硬门槛**
> 如果你以前在「将 iPhone 用作网络摄像头」的提示里点过「稍后提醒我」，macOS 会把这件事记成
> **引导未完成（incomplete onboarding）**，之后**再也不会发布**这台 iPhone 的摄像头。现象：
> `system_profiler SPCameraDataType` 里只有 `MacBook Air相机`，探针固定报 `out device of bound (0-0)`
> —— 也就是**只枚举到 1 个设备，根本不是 index 问题**。判据：
>
> ```bash
> log show --last 5m --predicate 'process == "ContinuityCaptureAgent"' --style compact \
>   | grep -E 'Skip camera publishing|considerToOnboard'
> # [com.apple.CMContinuityCapture:provider] Skip camera publishing due to incomplete onboarding. State = None
> # considerToOnboard:0 showTryItNow:0      ← 它拒绝弹引导
> ```
>
> 这个状态**不落在任何用户可读的 plist 里**（`com.apple.cmio.ContinuityCaptureAgent` 域不存在；
> `~/Library/Preferences`、容器、分组容器里搜不到 `RemindLater`；`/var/root` 需要 root），
> `killall ContinuityCaptureAgent` 之后依然存在；手动 `open` 引导宿主
> `CoreMediaIO.framework/…/ContinuityCaptureOnboardingUI.app` 只会显示那条「稍后提醒我」通知
> （它的窗口被设计成 1×1 像素，本身只是个通知宿主）。而且抑制规则里
> `remindLaterActiveForStreamClients:1` 只针对「正在请求视频流的客户端」——**只要 C 在跑
> （`hasClientsWithStreamIntent:1`），守护进程就永远判 `considerToOnboard:0`，引导不会弹**。
> 出路只有「让引导真正走完」（先停 C 再触发，或重启 Mac），成本都不低 ——
> **所以本项目推荐直接走路线 B**。

#### 路线 B：IP 摄像头 App（手机自己起流，Mac 去拉）

1. App Store 搜 `IP Camera` / `RTSP Server` 一类，选**能给出一个可访问地址**的 App；
2. 手机与 Mac 同一 WiFi，App 里「开始广播」，记下地址
   （MJPEG 常见 `http://<手机IP>:8080/video`，RTSP 常见 `rtsp://<手机IP>:8554/live`）；
3. 先验证地址（可一次给多个候选）：

```bash
python3 scripts/camera-probe.py --url http://192.168.11.20:8080/video http://192.168.11.20:8081/video
```

4. 让 C 用它：

```bash
python3 -u -m vision.main --source http://192.168.11.20:8080/video
```

> 要点：手机必须**保持前台不锁屏**（iOS 会挂起 App，流就断了）；网络流**不镜像**
> （`vision/main.py:207` 的规则是「仅摄像头默认镜像」，且没有 `--mirror` 开关，
> 所以网络流上 `--no-mirror` 是无效参数、加了也不会变）；macOS 防火墙首次会弹窗询问
> 是否允许 Python 接受连接，要允许。
>
> 桌面 / 后端这些组件**完全不用动**：C 拿到帧之后走的还是同一条 Pose → 事件 → `POST /events` 链路，
> 桌宠那边看到的事件和本机摄像头时一模一样。

5. 想让**整套栈**里那个 C（`dev-up.sh` 起的）直接吃手机流：

```bash
ipconfig getifaddr en0                                           # 先确认 Mac 自己的局域网 IP
ping -c 2 192.168.11.20                                          # 手机在同一 WiFi 上应能通
pkill -f 'm vision[.]main'                                       # 只停 C（B / 前端 / 桌宠不动）
VISION_SOURCE=http://192.168.11.20:8080/video ./scripts/dev-up.sh
grep 视频源 /tmp/human-observatory/logs/vision.log | tail -1      # 应打印 http://… 而不是 camera 0
```

> `dev-up.sh` 认两个环境变量：`VISION_SOURCE`（等价 `--source`，优先）和 `VISION_CAMERA`
> （等价 `--camera`）；**都不设就是原来的本机 0 号摄像头**，默认用法完全不变。已经在跑的组件会被
> `dev-up.sh` 跳过，所以换源要**先停掉 C** 再带变量启动。日志横幅里出现
> `视频源 http://… 640x480` 就说明生效了。
>
> 换回去也一样简单（不带变量就是本机 0 号摄像头）：
> `pkill -f 'm vision[.]main' && ./scripts/dev-up.sh`，横幅应变成 `视频源 camera 0 640x480`。

#### 真实 iPhone 实测记录（2026-09-26：路线 B 已打通）

本机用 iPhone 上一个 IP 摄像头 App（RTSP 服务，地址形如 `rtsp://<手机IP>:8554/live`）
把**整栈**跑通了：手机与 Mac 同一 WiFi，Mac 侧 OpenCV 4.11 带 `FFMPEG: YES`。
四步就是全部动作（IP 换成你自己手机的）：

```bash
python3 scripts/camera-probe.py --url rtsp://192.168.11.12:8554/live   # ① 先探一下
pkill -f 'm vision[.]main'                                             # ② 只停 C
VISION_SOURCE=rtsp://192.168.11.12:8554/live ./scripts/dev-up.sh       # ③ 整栈吃手机流
grep 视频源 /tmp/human-observatory/logs/vision.log | tail -1           # ④ 确认生效
```

| 验证项 | 实测结果 |
| --- | --- |
| 探针打开手机 RTSP | ✓ `720×1280 @ 30fps`，耗时 2.3s，首帧存 `probe/stream-rtsp---192.168.11.12-8554-live.jpg`，**肉眼确认就是手机拍的画面** |
| C 整栈吃手机流 | 横幅 `视频源 rtsp://192.168.11.12:8554/live 640x480`，紧接着 `[Video] 实际分辨率 720x1280 @ 30fps` |
| 事件全链路 | 手机流 → Pose → `PERSON_ENTER / PERSON_LEFT / PERSON_RETURNED` → `POST /events 201`；`GET http://127.0.0.1:8001/observations` 能查到对应记录（注意**后端是 8001**） |
| 喝水 VLM | `[Drinking] 疑似喝水已达 5 帧，截取 3 张关键帧调用 VLM` → `VLM 结论：…`（VLM 对 720p 帧照样工作） |
| CPU 开销（Apple M5，720p@30fps） | C 单进程约 **35% 单核 / 244MB / 44 线程**，绰绰有余，不需要降分辨率 |
| 网络流是否镜像 | 不镜像（同前文要点，`--no-mirror` 对网络流是无效参数） |
| **断流行为** | 见下面第 3 点：**fail-fast 但不自动重连** |

接到真实手机后最容易踩的三个点（都是本机实测出来的）：

1. **`--width/--height`（默认 640x480）对 RTSP 流不生效** —— 横幅里那个 `640x480` 只是「请求值」，
   实际分辨率由手机决定（本例竖屏 `720×1280`）。而且管线里**没有读后缩放**
   （`vision/` 里只有 VLM 内部会 resize），所以手机的 720p 会**原样**进 Pose。
   M5 上无压力；若你的机器更弱，请在**手机 App 侧**把分辨率 / 码率调低，别指望 `--width`。
2. **这个 App 不接受 RTSP over UDP**：OpenCV 会先吐一句
   `[rtsp @ 0x…] method SETUP failed: 461 Unsupported Transport`，然后自动退回 TCP ——
   **这是噪声不是故障**（照样能打开）。想消掉它、或想强制走 TCP（720p 在 WiFi 上更抗丢包）：

   ```bash
   export OPENCV_FFMPEG_CAPTURE_OPTIONS='rtsp_transport;tcp'
   ```

   两种传输都实测可开、可读帧，所以这只是可选项，不是必需步骤。
3. **断流不会自动重连**（实测方法：`scripts/rtsp-relay.py` 把手机流中继到本机，
   让 C 读中继，然后中途掐掉中继，等价于手机退后台 / 锁屏 / 掉 WiFi）：

   ```bash
   python3 scripts/rtsp-relay.py --target 192.168.11.12:8554 &        # ① 中继
   python3 -u -m vision.main --source rtsp://127.0.0.1:8555/live </dev/null &  # ② C 读中继
   pkill -f 'rtsp-relay[.]py'                                        # ③ 掐断，看 C 怎么反应
   ```

   C 在**断流后约 1 秒**打印 `[错误] 连续 60 帧读取失败，退出。` 并**以退出码 4 结束**
   —— 既不会僵死（TCP 断开时 `read()` 立刻返回失败，不会卡到 FFMPEG 的长超时），
   也不会自己重连。**恢复动作就是重跑上面第 ③ 步**（`dev-up.sh` 会跳过还在跑的 B / 前端 / 桌宠，
   只把 C 拉起来）。B / 前端 / 桌宠在 C 死掉期间不受影响，只是不再有新事件进来。
   这个脚本也能拿来量「断流后多久退出」，改天换了 App / 传输方式可以重跑一遍对比。

#### 配套工具：`scripts/camera-probe.py`

```bash
python3 scripts/camera-probe.py                        # 扫描 camera index 0~4
python3 scripts/camera-probe.py --indices 1 2          # 只试指定 index
python3 scripts/camera-probe.py --url <候选地址...>     # 试网络流
python3 scripts/camera-probe.py --url <地址> --show     # 额外弹窗预览，肉眼确认是不是 iPhone 拍的
```

它复用 `vision.video_source`（**和 `vision.main` 完全同一套解析与打开逻辑**），逐个尝试并：
打印 macOS 认识的摄像头名单、把首帧存到 `/tmp/human-observatory/probe/`、给出「下一步该填什么」。
全部失败时打印逐项自查清单。退出码：有可用源 `0`，全失败 `1`。

#### 我在本机实测过的验证记录（可复现）

没有 iPhone 在手边也能验证「Mac 侧这条路走得通」：仓库里带了 `scripts/fake-mjpeg-server.py`
（`multipart/x-mixed-replace` + JPEG，默认 `127.0.0.1:8099/video`，15fps），拿它冒充手机：

```bash
python3 scripts/fake-mjpeg-server.py &                                   # 充当「手机」
python3 scripts/camera-probe.py --url http://127.0.0.1:8099/video
python3 -u -m vision.main --source http://127.0.0.1:8099/video </dev/null
pkill -f fake-mjpeg-server.py                                            # 收尾
```

| 验证项 | 实测结果 |
| --- | --- |
| 探测脚本能识别网络流 | ✓ 可用 640×480，首帧存到 `probe/stream-http---...jpg`，退出码 0 |
| 首帧是真图（不是空帧） | 640×480 JPEG，打开可见服务端所发画面 |
| 探测脚本能拒绝坏地址 | `--url .../nope` → ✗ 打不开 + 提示，整体 `1/2 路可用`，退出码 0（有 1 路可用） |
| **C 整条管线吃网络流** | 横幅打印 `视频源 http://… 640x480`，随后 `[Video] 实际分辨率 640x480 @ 25fps` |
| **`dev-up.sh` 转发 `VISION_SOURCE`** | `VISION_SOURCE=http://127.0.0.1:8099/video ./scripts/dev-up.sh` → 打印 `· 视频源：--source …`，新 C 进程 argv 带 `--source http://127.0.0.1:8099/video`，横幅同上；B / 前端不受影响（仍 200） |
| **「只停 C」够不够**（换源前必须做的动作） | ✓ 够：`pkill -f 'm vision[.]main'` 之后，`vision.pid` 里那个包壳子 shell 会跟着退出，所以 `dev-up.sh` 的「已在运行就跳过」判断不会误判，C 会真被重启（实测新 pid 换成了带 `--source` 的那个） |

所以「给 `--source` 填一个 `http://…` / `rtsp://…` 就能让 C 用网络视频源」是**已验证事实**，不是推测
（`--camera <index>` 走的是同一套 `vision.video_source` 解析逻辑）。
连「iPhone 那一端的 App 会不会按你期望的地址吐流」这一环也**已经在真机上验证过了**（见上面
「真实 iPhone 实测记录」），包括断流后的行为 —— 现在剩下的只有环境差异：
手机 IP 会变（DHCP）、App 升级后地址 / 传输方式可能变，所以每次换环境都先跑一次
`scripts/camera-probe.py --url …` 确认。


### 6.6 用手机浏览器看（局域网访问，`LAN=1`）

A 的前端就是普通网页，**手机上不用装任何 App**：让 Mac 监听局域网、把前端要调的后端地址换成 Mac 的
局域网 IP，手机用 Safari 打开就行。**默认不开**（保持只本机可用），要手机访问就带 `LAN=1` 启动：

```bash
cd /Users/syyz/hacker
./scripts/dev-down.sh      # 后端监听地址 / 前端内联的地址都是启动期决定的 → 必须重启
LAN=1 ./scripts/dev-up.sh  # 想同时用手机当 C 的眼：LAN=1 VISION_SOURCE=rtsp://192.168.11.12:8554/live ./scripts/dev-up.sh
```

启动末尾会直接打印该往手机地址栏里敲的地址：

```
  手机访问（同一 WiFi）：http://192.168.11.156:3000/live
```

| 手机打开 | 你会看到 | 说明 |
| --- | --- | --- |
| **`/live`** | **推荐**：观察面板（实时事件流 / 状态 / 观察记录） | 纯轮询 B，窄屏自动单列（`lg:grid-cols-…`），手机上是可用的 |
| `/` | 桌宠桌面体验 | ⚠️ 这页要调**手机自己的摄像头**，而 iOS 在 `http://<内网IP>` 下**不给**（非安全上下文）→ 授权卡会说明「不是设备的问题」并让你**「不用摄像头，直接继续」**（桌宠 + 数据照常刷新，见下面「坑 2」）。要真拿到摄像头得 HTTPS；另外它上报的 `POST /frame`（8002）**C 侧尚未实现**（见 §1 端口表 / §10 第 3 条），所以手机摄像头目前喂不到识别链路 |
| `/pet` | 桌宠页 | 打得开，但这页是给 Electron 透明置顶窗设计的，浏览器里体验一般 |

`LAN=1` 一共就做四件事（默认全关，代码在 `scripts/dev-up.sh` + `app.py` + `frontend/next.config.ts`）：

1. **B 监听 `0.0.0.0:8001`**（默认 `127.0.0.1`）—— 不改的话手机根本连不上它；
2. **CORS 放行 `http://<Mac IP>:3000`**（由 `CORS_EXTRA_ORIGINS` 传给 B，`app.py` 的 `cors_origins()` 读取）
   —— 不改的话浏览器会把所有 `/observations` 轮询拦掉（控制台一片 CORS 报错）；
3. **前端内联 `NEXT_PUBLIC_API_BASE_URL=http://<Mac IP>:8001`**（`NEXT_PUBLIC_*` 是编译期内联，
   所以**必须重启前端**；以后 Mac 的 IP 变了也要重启）；
4. **放行 Next 的 dev 资源**（`next.config.ts` 的 `allowedDevOrigins`，见下面「坑 1」）——
   `LAN=1` 会顺手把当前 IP 也精确加进去（`ALLOWED_DEV_ORIGINS`），双保险。

#### ⚠️ 坑 1：手机打开是「死页」——能看见界面，但**点不动、数据不刷新**

Next 16 的 dev server 默认**拦掉来自其它 host 的 dev 私有资源**（`/_next/*`、`/__nextjs*`），
日志里是这一句、HTTP 是 403：

```
⚠ Blocked cross-origin request to Next.js dev resource /_next/hmr from "192.168.11.156".
  Cross-origin access to Next.js dev resources is blocked by default for safety.
```

后果正是「死页」：**HTML/样式能出来，但 hydration 用的 dev chunk 被 403 掉 → 客户端 JS 不执行 →
按钮点不动、`/observations` 永远不刷新**（而 Next 启动横幅还照样宣传 `Network: http://<IP>:3000`，专坑人）。

本项目已在 `frontend/next.config.ts` 里配好 `allowedDevOrigins`（默认放行 `localhost`、`*.local` 和
`10.*.*.*` / `192.168.*.*` / `172.16.*.*` 这些私网段；匹配是**按点分段**的通配，`*` 一段、`**` 剩余段）。
换了别的网段（公司网、Tailscale、自定义域名）就加环境变量：

```bash
ALLOWED_DEV_ORIGINS=mac.tailnet.ts.net,192.168.50.7 LAN=1 ./scripts/dev-up.sh
```

**改完必须重启前端**（`next.config.ts` 只在启动时读）。`dev-up.sh` 结束时的状态区会**自动自检**
这一条 —— 出现下面这行就说明又被拦了：

```
  [!] 手机的 dev 资源被 Next 拦了（HTTP 403）→ 页面会「能看不能点」！
```

> 判断是不是这个坑，最快的办法：手机 Safari 里页面能看但点不动时，Mac 上执行
> `tail -20 /tmp/human-observatory/logs/frontend.log`，看到 `Blocked cross-origin` 就是它。
> 手动复现（应返回 **非 403**）：
> ```bash
> curl -o /dev/null -w '%{http_code}\n' -H 'Referer: http://<Mac IP>:3000/live' \
>   -H 'Sec-Fetch-Mode: no-cors' -H 'Sec-Fetch-Site: cross-site' \
>   'http://<Mac IP>:3000/_next/hmr'
> ```

#### ⚠️ 坑 2：手机上 `/` 报「没找到可用的摄像头」——**不是设备的问题**

`/`（桌面体验页）要调**手机自己的摄像头**，而 **iOS / Android 只在 HTTPS 或 localhost 下提供
`navigator.mediaDevices`**：用 `http://<Mac IP>:3000` 打开时，这个 API 整个是 `undefined`，
旧文案就会甩锅给设备（说「没找到可用的摄像头」）。

现在授权卡会认出这种情况（`hooks/useCamera.ts` 给出 `reason: "insecure-context"`，
另外卡片自己也用 `useSyncExternalStore` 提前探 `isSecureContext`，所以**手机一进来就直接变脸**，
不必先点「开始体验」）并改成人话，同时给两条走得通的路：

- **「不用摄像头，直接继续」**（主按钮）：跳过摄像头 → 桌宠、气泡、`/observations` 轮询照常工作，
  数据一点不缺（只是 `/` 里的抓帧 / 送帧没有素材）；
- **「只想看观察面板 → 打开 `/live`」**：`/live` 本来就不需要摄像头。

要真在手机上用摄像头（只服务 `/` 的抓帧 + 送帧），得给前端套 HTTPS：

```bash
cd frontend && npx next dev --experimental-https   # 自签证书；iPhone 首次会拦，需「显示详细信息 → 继续访问」
```

但请注意：**即使拿到摄像头，那一路帧也是发给 C 的 `POST /frame`（8002），而 C 还没实现这个接口**
（§10 第 3 条）—— 想让手机当识别链路的眼睛，请走 6.5 节的**路线 B**（手机 App 推 RTSP，Mac 去拉）。

> 为什么「推送 RTSP 的 App」可以、网页不行？因为 App 走的是系统相机权限（不需要安全上下文），
> 而网页的 `getUserMedia` 是**安全上下文独占**能力，HTTPS 是硬门槛。

#### ⚠️ 坑 3：**同一台手机不能既当摄像头又看页面**

路线 B（手机 App 推 RTSP 给 C）和「手机浏览器看 `/live`」在**同一台手机上互斥**：
iOS 一旦把 Safari 切到前台，就会把推流 App 挂起 → 流断 → C 直接报
`OpenCV: Couldn't read video stream from file` 然后**退出**（C 是 fail-fast、不自动重连，见 6.5 节）。

所以两种玩法二选一：

| 想干什么 | 怎么配 |
| --- | --- |
| **手机只当「看点」**（推荐，最稳） | C 用 Mac 本机摄像头（默认，不加任何参数）→ 手机随便开 Safari 看 `/live`，两边不打架 |
| **手机当摄像头**（路线 B） | `VISION_SOURCE=rtsp://<手机IP>:8554/live ./scripts/dev-up.sh`；此时**推流 App 要保持前台**，看页面请换**另一台设备**（iPad / 另一部手机 / 电脑） |

> dev 模式首次打开 `/live` 手机上会等十几秒（Turbopack 要按需编译、要下载一堆 dev chunk）。
> 要手机秒开就临时跑生产模式（生产模式也不受「坑 1」影响）：
> ```bash
> cd frontend
> NEXT_PUBLIC_API_BASE_URL=http://192.168.11.156:8001 npm run build && npm run start
> ```

关掉就是不带 `LAN=1` 重启：`./scripts/dev-down.sh && ./scripts/dev-up.sh`（回到只本机可用）。

> ⚠️ **只在可信局域网用**：B 没有鉴权，`LAN=1` 期间同一 WiFi 下任何设备都能读写观察记录 ——
> 公共 WiFi 上别开（本项目本就不该暴露到公网，见 §10 第 7 条）。
> 若 macOS 开了防火墙，首次会弹「是否允许 Python / node 接受传入连接」，**必须允许**，否则手机连不上。

本机实测（2026-09-26，Mac `192.168.11.156`，手机 `192.168.11.12`）：

| 验证项 | 结果 |
| --- | --- |
| B 局域网可达 | `curl http://192.168.11.156:8001/health` → 200（`lsof` 显示监听已从 `127.0.0.1:8001` 变成 `*:8001`） |
| CORS 放行手机来源 | `curl -H 'Origin: http://192.168.11.156:3000' http://192.168.11.156:8001/observations` → 响应头带 `access-control-allow-origin: http://192.168.11.156:3000` |
| 前端局域网可达 | `curl http://192.168.11.156:3000/live` → 200 |
| API 地址真的内联了 | 客户端 chunk 里是 `("TURBOPACK compile-time value", "http://192.168.11.156:8001")`，不是 `localhost` |
| 默认行为没变 | 不带 `LAN=1`：`cors_origins()` 仍只有原来两个来源，B 仍只监听 `127.0.0.1`；`dev-up.sh` 只多打印一行「只本机可访问；想让手机打开就带 LAN=1 重启」 |
| 防火墙 | 本机 `socketfilterfw --getglobalstate` = **disabled**，所以没有弹窗；开了防火墙才需要点允许 |
| Next 的 dev 资源放行（6.6 节坑 1） | 修 **前**：手机式请求 `/_next/hmr` → **`403 Unauthorized`**（日志 `Blocked cross-origin request … from "192.168.11.156"`）；配好 `allowedDevOrigins` 并重启前端 → `/live` HTML 里那一串 dev chunk **全部 200**，手机不再「死页」 |
| 手机推流 vs 手机看页面（6.6 节坑 3） | 打开 Safari 看页面后，手机 `8554` 探测**不通**（推流 App 被挂起），C 日志 `Stream timeout triggered after 30003 ms` → `无法打开视频源` 退出；改用 **Mac 本机摄像头** 后 C 立刻恢复（`PERSON_ENTER` 检测到、`POST /events -> 201`） |
| 手机 `/` 的摄像头（6.6 节坑 2） | `http://` 局域网地址下 `navigator.mediaDevices` 为 **`undefined`** → 旧文案会说「没找到可用的摄像头」；现在 `useCamera` 给 `reason: "insecure-context"`，卡片改说「不是设备的问题」并主推**「不用摄像头，直接继续」**（`tsc --noEmit` 通过，新文案已进客户端产物） |

---

## 7. 常见问题排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 日志里出现 `[exit] 收到退出按键`，C 自己退了 | 后台启动时 stdin 没接 `/dev/null`，`cv2.waitKey` 读到了终端输入 | 加 `</dev/null` 重启（见 5.3 节）；`dev-up.sh` 已处理 |
| 桌宠一直不说「喝水」 | `VLM_API_KEY` 没配 / 配错，喝水裁决只能返回 `NONE` | `python3 -m vision.selftest_vlm_live` 看打码后的 key、base_url、model；**其余功能不受影响** |
| 报 `401 / 403` | key 不对 / 已失效 | 换 key，确认 `.env` 里没有多余空格与引号 |
| 报 `400 / 404` | 模型名不对 | 确认 `VLM_MODEL` 在账号下有权限（如 `qwen-vl-plus`） |
| **`/events` 返回 422** | 契约不符：`subject_id` 非 `HUMAN_001`、`confidence` 越界、`timestamp` 没带时区 | 按 6.1 节表逐字段核对 |
| 前端页面空白 / 拿不到数据 | B 没起，或前端连的不是 8001 | `curl 127.0.0.1:8001/health`；必要时改 `frontend/.env.local` 里的 `NEXT_PUBLIC_API_BASE_URL`（**改完要重启 dev**） |
| 浏览器控制台报 CORS | 前端不是 `localhost:3000` | 换回 3000，或在 `app.py` 的 `allow_origins` 里加白名单 |
| 摄像头黑屏 / 打不开 | macOS 没给终端摄像头权限，或被别的 App 占用 | 系统设置 → 隐私与安全性 → 摄像头，勾上终端 / iTerm 后**重启终端** |
| `system_profiler SPCameraDataType` 里只有 `MacBook Air相机`，探针报 `out device of bound (0-0)` | iPhone 的连续互通相机**没被 macOS 发布**（引导未完成），**不是 index 问题，别再扫 1/2/3/4** | 走 6.5 节的**路线 B**（IP 摄像头 App）；路线 A 的前因后果见 6.5 节那段 ⚠️ |
| 换了手机视频源，C 还在拍本机 | C 是 `dev-up.sh` 用默认参数起的，没带 `--source` | `pkill -f 'm vision[.]main'` 后 `VISION_SOURCE=http://… ./scripts/dev-up.sh`，再 `grep 视频源 …/vision.log` |
| **C 在跑手机流时忽然退出**，日志结尾 `[错误] 连续 60 帧读取失败，退出。` | 手机那一端流断了（App 退后台 / 手机锁屏 / 掉 WiFi）；**C 不会自动重连**，约 1 秒后以退出码 4 结束 | 让手机 App 回到前台，重跑 `./scripts/dev-up.sh`（B / 前端 / 桌宠会跳过，只拉起 C）；复现方法见 6.5 节第 3 点 |
| 横幅写 `640x480`，紧接着却打印 `实际分辨率 720x1280` | 正常：`--width/--height` 对 RTSP 流不生效，分辨率由手机决定 | 不用管；嫌 720p 吃 CPU 就在**手机 App 侧**调低（见 6.5 节坑 1） |
| 日志里 `[rtsp @ …] method SETUP failed: 461 Unsupported Transport` | 手机 App 不接受 RTSP over UDP，OpenCV 自动退回 TCP | 正常噪声，不是故障；想消掉它就 `export OPENCV_FFMPEG_CAPTURE_OPTIONS='rtsp_transport;tcp'` |
| 手机上 `/` 提示「没找到可用的摄像头」/「浏览器不开放摄像头」 | iOS 在 `http://<内网IP>` 下**不提供** `navigator.mediaDevices`（安全上下文限制），和「设备有没有摄像头」无关 | 点卡片上的**「不用摄像头，直接继续」**（桌宠 + 数据照常），或直接用 `/live`；想在手机上真用摄像头需 HTTPS（6.6 节「坑 2」） |
| **手机页面「能看不能点」**（HTML/样式正常出来了，但按钮无反应、数据永不刷新） | Next 16 默认 **403 掉跨源 dev 资源**：前端日志里有 `Blocked cross-origin request to Next.js dev resource /_next/hmr from "<手机来源>"` | 配 `frontend/next.config.ts` 的 `allowedDevOrigins` 并**重启前端**（6.6 节「坑 1」；`dev-up.sh` 状态区会自动自检这一项） |
| 手机能打开页面，但数据一直是空 / 控制台一片 CORS 报错 | 启动时没带 `LAN=1`：B 只监听 `127.0.0.1`，且 CORS 白名单里没有手机那个来源 | `./scripts/dev-down.sh && LAN=1 ./scripts/dev-up.sh`（见 6.6 节） |
| 手机打开时页面能出来，但请求发到了 `localhost:8001` | 前端是在**没有** `LAN=1` 时编译的：`NEXT_PUBLIC_*` 是编译期内联，改完必须重启前端 | 同上，必须 `dev-down` 后带 `LAN=1` 重启（Mac 换 IP 也一样） |
| 手机上 `/` 页卡在「请授权摄像头」 | iOS Safari 在 `http://<内网IP>` 下**不给** `getUserMedia`（非安全上下文，要 HTTPS） | 手机上看 **`/live`**；要手机摄像头当视频源就走 6.5 节路线 B |
| 端口被占（3000 / 8001） | 上次没退干净 | `./scripts/dev-down.sh`；前端会自动换到 3001，此时用 `PET_URL` 指向它 |
| 桌宠窗口「看得见但点不到」 | 命中判定异常 | 全局快捷键 `Cmd/Ctrl+Shift+Alt+R` 重载，或 `+Q` 退出重开 |
| 喝水识别很频繁 / token 烧得快 | 15s 冷却 + Pose 启发式偏宽松 | `--drink-cooldown 60 --drink-keyframes 1` |
| 同一事件文案永远一样 | B 的 `NARRATIVE` 是固定映射 | 属当前设计；要多样化需改 B 侧生成 |

看日志：

```bash
tail -f /tmp/human-observatory/logs/vision.log      # C 的识别过程与 VLM 结论
tail -f /tmp/human-observatory/logs/backend.log     # B 的每次 POST / 422
tail -f /tmp/human-observatory/logs/frontend.log
tail -f /tmp/human-observatory/logs/pet.log         # Electron 壳（含环境自检）
```

---

## 8. 自测与验收

### 8.1 C：离线自测（不需要网络，需要 cv2 / numpy）

```bash
python3 -m vision.selftest_drinking_vlm     # 喝水：Pose 分支 + 假 VLM
python3 -m vision.selftest_event_manager    # 事件 JSON 契约 / 去抖
python3 -m vision.selftest_event_sender     # 上报 B 的重试与容错
python3 -m vision.selftest_video_source     # 视频源解析
```

全部通过（`PASS`）时退出码 0。

### 8.2 C：VLM 联网探针（**排查配置问题最有用的一条**）

```bash
python3 -m vision.selftest_vlm_live                      # 配置 + 文本往返
python3 -m vision.selftest_vlm_live --image frame.jpg    # 再多验证一次图片往返
```

零第三方依赖，媒体库没装也能跑。输出里会打印 `.env` 来源、打码后的 key、`base_url`、`model`；
`401/403` 直接提示「key 不对」，`400/404` 提示「模型名不对」。

### 8.3 A ↔ B 契约自检

```bash
cd frontend && npm run check:b     # 只读接口
node check-b-contract.mjs --write  # 仓库根，额外真实写一条测试记录
```

### 8.4 端到端验收清单（演示前 2 分钟过一遍）

- [ ] `curl 127.0.0.1:8001/health` → `{"status":"ok"}`
- [ ] `tail -20 /tmp/human-observatory/logs/vision.log` 有 `VLM : qwen-vl-plus ...（.env: .env）` 横幅
- [ ] `/`、`/live`、`/pet` 三个路由都 200
- [ ] 走进镜头 → 桌宠气泡出现「检测到未知碳基生命体…」
- [ ] **喝一口水** → 日志出现 `[Drinking] VLM 结论：DRINKING`，气泡出现「目标正在为内部海洋补充液体。」
- [ ] `curl 127.0.0.1:8001/species-card` 里 `DRINKING` 计数 +1
- [ ] 无 `[exit] 收到退出按键`（C 稳定存活）

---

## 9. 目录结构

```
hacker/
├─ app.py                     B 后端（FastAPI + SQLite + NARRATIVE 叙事映射）
├─ observations.sqlite3       B 的落库文件（自动生成，可删）
├─ .env / .env.example        VLM 与上报配置（.env 不入库）
├─ .venv/                     B 的 Python 依赖
├─ scripts/
│   ├─ dev-up.sh              一键启动（后端 → 前端 → 视觉 → 桌宠；VISION_SOURCE 换 C 的视频源，LAN=1 开手机访问）
│   ├─ dev-down.sh            一键停止（pid 树 → 端口 → 进程特征）
│   ├─ camera-probe.py        摄像头 / 网络流探测（找 index、验 URL，见 6.5）
│   ├─ fake-mjpeg-server.py   假 MJPEG 服务（没有手机时验证网络源链路，见 6.5）
│   └─ rtsp-relay.py          RTSP TCP 中继（掐断它复现「手机流中断」，见 6.5）
├─ check-b-contract.mjs       A → B 契约自检脚本
├─ vision/                    C：摄像头 / Pose / 动作识别 / VLM（含 5 个 selftest）
├─ frontend/                  A：Next.js（/ · /live · /pet · /pet-preview）
├─ desktop/                   桌宠 Electron 壳（透明 / 置顶 / 穿透）
└─ models/                    MediaPipe Pose .task 模型
```

**一键启停速查**：

```bash
./scripts/dev-up.sh      # 起全部（幂等）
./scripts/dev-down.sh    # 停全部（三重兜底）
```

---

## 10. 已知限制（如实说明）

1. **单主体**：`subject_id` 固定 `HUMAN_001`，其他 id 一律 404 或 422。
2. **文案固定**：B 的 `NARRATIVE` 对同一 `event` 输出同一句，没有随机化 / LLM 生成。
3. **A → C 送帧没有接收方**：`/frame` 契约已定稿（含自检脚本），前端 `/` 桌面体验页**确实会**
   每 500ms `POST` 一拍（`features/camera/useFrameReporter.ts`，经 `DesktopExperience` 接线），
   但 **C 侧没有实现 `/frame` 服务** —— `vision/` 里没有任何 8002 监听（`lsof` 验证过 C 不监听任何
   TCP 端口），所以这些帧现在**没人接**（前端静默失败，不影响其余功能）。
   C 自己读视频源（本机摄像头 / RTSP / MJPEG），不依赖前端送帧。
4. **喝水是「疑似 + 裁决」两段式**：Pose 只做宽松筛选（手腕离嘴 ≤ 0.30），最终判断靠 VLM，
   因此需要联网且有 token 成本；VLM 偶尔返回非法 `confidence` 会被夹到 `0.00`（结论不受影响）。
5. **桌面版不带摄像头**：`/pet` 只做「陪伴 + 轮询 B」，送帧能力在 `/` 侧。
6. **久坐 / 静止类事件**暂无：桌宠的「久坐预警」是 A 侧本地模拟，未走 B 的库。
7. **本项目是单机 MVP**：无鉴权、无并发设计，不要直接暴露到公网。
8. **iPhone 当摄像头（6.5 节）的前提与已实测的坑**：连续互通相机要求 iPhone 与 Mac 同 Apple ID、
   手机解锁且在附近，且它的 **camera index 会随连接状态变化**（所以每次都得用
   `scripts/camera-probe.py` 确认）；用 IP 摄像头 App 则要求手机 App **保持前台不锁屏**
   （iOS 会挂起后台 App，流就断）。两者都还依赖 **Mac 不睡眠 / 不锁屏**。
   走网络流（路线 B）另有三个实测结论：**①** `--width/--height` 对 RTSP 流不生效，
   实际分辨率由手机决定（本项目管线没有读后缩放，720p 会原样进 Pose，M5 上约 35% 单核）；
   **②** **断流后 C 不会自动重连** —— 约 1 秒内打 `[错误] 连续 60 帧读取失败，退出。`
   并以**退出码 4** 结束，恢复动作是重跑 `dev-up.sh`（B / 前端 / 桌宠不受影响，只是没有新事件）；
   **③** 手机 IP 由 DHCP 分配，换网络 / 重启路由后会变，地址要从 App 里重新确认。
9. **连续互通相机在本机实测不可用（2026-09-26）**：macOS 侧那次「将 iPhone 用作网络摄像头」的引导
   没走完（早先被点过「稍后提醒我」），守护进程持续输出 `Skip camera publishing due to incomplete
   onboarding. State = None`，于是 iPhone 的摄像头**根本不进系统设备列表**：`system_profiler
   SPCameraDataType` 只有 MacBook Air 相机，探针固定报 `out device of bound (0-0)`（只枚举到 1 个设备）。
   这个标记不在任何用户可读的 plist 里、`killall ContinuityCaptureAgent` 也清不掉，而且**只要 C 占着
   摄像头，守护进程就永远不弹引导**（`considerToOnboard:0`）。排查全过程见 6.5 节那段 ⚠️ ——
   结论：这类机器上**直接用路线 B**，别在路线 A 上耗时间。

10. **手机浏览器访问（6.6 节）的边界**：`LAN=1` 期间 B 监听 `0.0.0.0:8001` 且**没有任何鉴权** ——
    同一局域网内谁都能读写观察记录，所以只在可信网络开、用完 `./scripts/dev-down.sh && ./scripts/dev-up.sh`
    关掉。另外 iOS 在 `http://<内网IP>` 下**不给** `getUserMedia`（须 HTTPS，即安全上下文），
    所以手机上最实用的是 `/live` 这种纯轮询页；`/` 现在会说明情况并允许跳过摄像头继续用
    （见第 13 条），「用手机摄像头喂 C」在当前实现里走不通，要那个效果就走 6.5 节的路线 B
    （手机 App 起流，Mac 去拉）。
11. **「手机推流」与「手机看页面」互斥**（实测踩到）：iOS 会把后台的推流 App 挂起，于是 C 拿不到流 →
    C 是 fail-fast、直接退出（不会自动重连）。所以要么 **C 用 Mac 本机摄像头 + 手机只看页面**（推荐、最稳），
    要么 **手机推流 + 用另一台设备看页面**。别指望一台手机同时干这两件事（详见 6.6 节坑 3）。
12. **Next dev 模式拦跨源 dev 资源**（实测踩到，现象是「页面能看不能点」）：Next 16 默认对来自
    其它 host 的 `/_next/*` 返回 **403**，`next.config.ts` 的 `allowedDevOrigins` 没配够就会中招 ——
    `LAN=1` 下 `dev-up.sh` 已内置自检；生产模式（`next build && next start`）不受影响（详见 6.6 节坑 1）。
13. **手机上 `/` 的摄像头拿不到（HTTPS 硬门槛）**：网页的 `getUserMedia` 是**安全上下文独占**能力，
    iOS 在 `http://<内网IP>` 下会把 `navigator.mediaDevices` 整个藏起来（iOS 的**原生 App** 推 RTSP
    不受这个限制，所以路线 B 没事）。前端现在会把这种情况标成 `insecure-context`，卡片明说
    「不是设备的问题」并允许**「不用摄像头，直接继续」**；想真在手机上用摄像头得给前端套 HTTPS
    （`npx next dev --experimental-https`），但**那一路帧发往 C 的 `/frame`（8002）而 C 尚未实现**
    （见第 3 条），所以它目前喂不到识别链路（详见 6.6 节坑 2）。

---

## 11. 文档索引

| 文档 | 内容 |
| --- | --- |
| **README.md（本文）** | 跑起来 / 用起来 / 排错 |
| `产品说明文档.md` | 一页读完的产品说明：定义 / 体验 / 状态机 / 边界（非开发同学看这个） |
| `03-人类观察站-项目定义.md` | 项目定位与整体设计 |
| `04-MVP与Aha Moment定义.md` | MVP 边界与 Aha Moment |
| `A交付B说明.md` | A ↔ B 契约、前端工程与桌面壳说明 |
| `A交付C说明.md` | A → C 送帧契约与联调方法 |
| `vision/README.md` | C 的模块细节与配置（本文 6.3 节的展开） |
| `桌宠UI框架.md` | 桌宠的视觉与动效设计 |
| `01` / `02` / `A部分实施步骤.md` / `提交测试.md` | 主题阐释、思维发散、实施步骤、提交测试 |

