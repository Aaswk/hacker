# Vision 模块（C：摄像头 / Pose / 动作识别 / VLM）

桌宠观察人类的视觉侧：视频源 → MediaPipe Pose → 人物进出 / 伸展 / 喝水 检测
→ Event Manager → `POST /events` 发给 B。

```
vision/
  video_source.py          统一视频源（摄像头 / RTSP / HTTP-MJPEG / 本地文件）
  pose_detector.py         MediaPipe Pose 关键点
  presence_detector.py     人物进出 / 离开 / 回来
  stretching_detector.py   伸懒腰
  drinking_vlm_detector.py 喝水：Pose 疑似 → 截关键帧 → VLM 裁决（后台线程）
  vlm_client.py            OpenAI 兼容 /chat/completions 客户端（纯标准库）
  dotenv.py                零依赖 .env 加载器
  event_manager.py         统一事件 JSON
  event_sender.py          异步 POST 到 B 的 /events
  main.py                  串流程的演示入口
```

## 配置：写在 `.env`，不写进代码

`vision` 包被导入时会自动加载项目根目录的 `.env`、`.env.local`
（`vision/dotenv.py`，纯标准库实现）。**密钥只放本机 `.env`，`.env` 已在
`.gitignore` 里；仓库里只留不含密钥的 `.env.example`。**

优先级：`shell 里 export 的变量` > `.env.local` > `.env`。

```bash
cp .env.example .env      # 模板已包含下面所有变量
```

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `VLM_API_KEY` | 空 | **必填**；没有它喝水检测直接返回 NONE，其余功能不受影响 |
| `VLM_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | VLM 的 OpenAI 兼容地址 |
| `VLM_MODEL` | `qwen-vl-plus` | 视觉模型；也可用 `qwen3-vl-plus` / `qwen-vl-max` |
| `VLM_TIMEOUT` | `15` | 单次 VLM 请求超时（秒） |
| `BACKEND_BASE_URL` | 空 | B 的地址，如 `http://localhost:8001`；不填则只打印不发送 |
| `BACKEND_TIMEOUT` | `5` | 发给 B 的请求超时（秒） |

## 依赖

`vision/requirements.txt`（mediapipe / opencv / numpy）。建议单独 venv，
不要和 B 的 FastAPI venv 混装：

```bash
python3 -m venv .venv-vision
.venv-vision/bin/pip install -r vision/requirements.txt
.venv-vision/bin/python -m vision.main            # 本机摄像头
.venv-vision/bin/python -m vision.main --source rtsp://user:pass@ip:554/stream
.venv-vision/bin/python -m vision.main --source /path/to/video.mp4
```

退出：预览窗口里按 `q` / `ESC`，或终端 `Ctrl+C`。

> ⚠️ 后台跑（`nohup ... &` / 脚本里起）时，**必须把 stdin 接到 `/dev/null`**：
> ```bash
> nohup python3 -u -m vision.main </dev/null > /tmp/vision.log 2>&1 &
> ```
> macOS 上 OpenCV 的 `cv2.waitKey` 会读到「启动它的那个终端」里输入的字符，
> `q`/`ESC`（113/27）正好就是本模块的退出键 —— 结果是终端里随便敲点东西，
> 预览窗口就自己退出了，日志里只留一行 `[exit] 收到退出按键`。`nohup` 不会替你
> 摘掉 stdin，所以必须显式重定向。`scripts/dev-up.sh` 已经这么做了。

## 一键启动（推荐，全项目四个组件）

```bash
./scripts/dev-up.sh      # 后端 → 前端 → 视觉(VLM) → 桌宠，日志在 /tmp/human-observatory/logs/
./scripts/dev-down.sh    # 停掉全部（pid 文件 + 端口 + 进程特征三重兜底）
```

`dev-up.sh` 会打印 C 的启动横幅（含 VLM 来源）、前端三个路由的 HTTP 状态和 B 的观察记录数。

## 自测

不联网（假 VLM，覆盖 Detector 分支，需要 numpy/cv2）：

```bash
.venv-vision/bin/python -m vision.selftest_drinking_vlm
.venv-vision/bin/python -m vision.selftest_event_manager
.venv-vision/bin/python -m vision.selftest_event_sender
.venv-vision/bin/python -m vision.selftest_video_source
```

联网探针（**只验证 VLM 这一条链路**：key / 网络 / 模型 / 图片能不能传进去）。
零第三方依赖，媒体库没装也能跑，专门用来排查配置问题：

```bash
python3 -m vision.selftest_vlm_live                      # 配置 + 文本往返
python3 -m vision.selftest_vlm_live --image frame.jpg    # 再多验证一次图片往返
```

输出里会把 `.env` 来源、打码后的 key、base_url、model 全打出来；
`401/403` 会直接提示「key 不对」，`400/404` 提示「模型名不对」。

## 与其他模块的边界

* C → B：只有 `POST /events`（`event_sender.py`），字段由 `event_manager.py` 按契约构造；
* A → C：A 的前端按 `POST http://localhost:8002/frame` 送帧（见《A交付C说明.md》）；
* 本模块不碰前端，也不直接改 B 的库。
