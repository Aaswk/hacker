#!/usr/bin/env bash
# 人类观察站 · 一键启动全部组件
#
#   启动：  ./scripts/dev-up.sh
#   停止：  ./scripts/dev-down.sh
#   日志：  /tmp/human-observatory/logs/{backend,frontend,vision,pet}.log
#   PID ：  /tmp/human-observatory/{backend,frontend,vision,pet}.pid
#
# 启动顺序（后面的依赖前面的）：
#   backend  B  FastAPI + SQLite        127.0.0.1:8001   （.venv）
#   frontend    Next dev                localhost:3000
#   vision   C  摄像头 + Pose + 喝水VLM  （需根目录 .env 里的 VLM_API_KEY）
#   pet          Electron 透明置顶桌宠壳（加载前端 /pet）
#
# 可选环境变量（只影响 C 的视频源；都不设 = 原来的本机 0 号摄像头）：
#   VISION_SOURCE  统一视频源，等价 --source：http(s)://…（MJPEG）/ rtsp://… / 视频文件 / 数字 index
#   VISION_CAMERA  摄像头 index，等价 --camera（VISION_SOURCE 优先）
#   例（拿 iPhone 上的 IP 摄像头 App 当眼睛，见 README 6.5 节）：
#     VISION_SOURCE=http://192.168.11.20:8080/video ./scripts/dev-up.sh
#
#   LAN=1  额外开放「手机浏览器」访问（默认只本机可用，见 README 6.6 节）：
#          B 监听 0.0.0.0、CORS 放行 http://<Mac 局域网 IP>:3000、
#          前端 API 地址内联成 http://<Mac 局域网 IP>:8001
#   例（手机看观察面板，同时用手机当 C 的眼）：
#     LAN=1 VISION_SOURCE=rtsp://192.168.11.12:8554/live ./scripts/dev-up.sh
#   注意：LAN=1 会让同一局域网内的设备都能读写 B（无鉴权），用完记得关掉。
#
# 说明：C 需要 mediapipe/opencv/numpy，本机装在系统 python3（Command Line Tools 3.9）里，
#      所以这里显式用 python3 起 C，用 .venv 起 B。换机器见 vision/requirements.txt。
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="/tmp/human-observatory"
LOG_DIR="$RUN_DIR/logs"
mkdir -p "$LOG_DIR"

BACKEND_PORT=8001
FRONTEND_PORT=3000
BACKEND_HOST="127.0.0.1"

# LAN=1：手机等局域网设备也要能访问（README 6.6 节）。
# 取默认路由那块网卡的 IP；取不到就退回本机模式，不半途而废。
LAN_IP=""
if [ -n "${LAN:-}" ]; then
  LAN_IFACE="${LAN_IFACE:-$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')}"
  LAN_IP="$(ipconfig getifaddr "${LAN_IFACE:-en0}" 2>/dev/null || true)"
  if [ -z "$LAN_IP" ]; then
    echo "  [!] LAN=1 但取不到局域网 IP（网卡 ${LAN_IFACE:-en0}），仍按只本机模式启动" >&2
  else
    BACKEND_HOST="0.0.0.0"
    # 前端来源 = 手机浏览器地址栏那个 origin，必须进 B 的 CORS 白名单
    export CORS_EXTRA_ORIGINS="http://$LAN_IP:$FRONTEND_PORT"
    # NEXT_PUBLIC_* 是编译期内联：必须在 npm run dev 之前设好，改了要重启前端
    export NEXT_PUBLIC_API_BASE_URL="http://$LAN_IP:$BACKEND_PORT"
    export NEXT_PUBLIC_VISION_URL="http://$LAN_IP:8002"
    # Next 16 默认 403 掉「跨源」的 dev 私有资源（/_next/*），手机加载不到 dev chunk 会变成
    # 「死页」（能看不能点）。next.config.ts 里已按私网段默认放行，这里再把当前 IP 精确加上（双保险）。
    export ALLOWED_DEV_ORIGINS="${ALLOWED_DEV_ORIGINS:+$ALLOWED_DEV_ORIGINS,}$LAN_IP"
  fi
fi

# up <名字> <工作目录> <命令...>
up() {
  local name="$1" dir="$2"
  shift 2
  local pid_file="$RUN_DIR/$name.pid"
  if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    echo "  · $name 已在运行（pid $(cat "$pid_file")），跳过"
    return 0
  fi
  # stdin 必须显式接到 /dev/null：macOS 上 OpenCV 的 waitKey 会读到「启动它的那个终端的
  # 字符」，q/ESC（113/27）会被当成退出键，于是终端一有输入、预览窗口就自己退出
  # （日志表现为 [exit] 收到退出按键）。nohup 不会替你摘掉 stdin，所以这里手动重定向。
  ( cd "$dir" && nohup "$@" >"$LOG_DIR/$name.log" 2>&1 </dev/null & echo $! >"$pid_file" )
  echo "  · $name  pid $(cat "$pid_file")  →  $LOG_DIR/$name.log"
}

# wait_port <端口> <名字> [超时秒]
wait_port() {
  local port="$1" name="$2" timeout="${3:-30}" i=0
  while [ "$i" -lt "$timeout" ]; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
      echo "  · $name 已监听 :$port"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  echo "  [!] $name 端口 $port 在 ${timeout}s 内没起来，看 $LOG_DIR/$name.log" >&2
  return 1
}

echo "== 1/4  B 后端（端口 ${BACKEND_PORT}，监听 ${BACKEND_HOST}） =="
up backend "$ROOT" "$ROOT/.venv/bin/python" -m uvicorn app:app --host "$BACKEND_HOST" --port "$BACKEND_PORT"
wait_port "$BACKEND_PORT" backend || exit 1
curl -sf "http://127.0.0.1:$BACKEND_PORT/health" >/dev/null && echo "  · /health 200 OK"

echo "== 2/4  前端（端口 ${FRONTEND_PORT}） =="
up frontend "$ROOT/frontend" npm run dev
wait_port "$FRONTEND_PORT" frontend || exit 1

echo "== 3/4  C 视觉 + VLM =="
if [ -f "$ROOT/.env" ]; then
  echo "  · 已找到 $ROOT/.env"
else
  echo "  [!] 没有 $ROOT/.env —— 喝水检测将没有 VLM 密钥（照 .env.example 建一个）" >&2
fi
# C 的视频源：默认本机 0 号摄像头；可用 VISION_SOURCE / VISION_CAMERA 覆盖（见文件头说明）
VISION_ARGS=()
if [ -n "${VISION_SOURCE:-}" ]; then
  VISION_ARGS+=(--source "$VISION_SOURCE")
elif [ -n "${VISION_CAMERA:-}" ]; then
  VISION_ARGS+=(--camera "$VISION_CAMERA")
fi
if [ "${#VISION_ARGS[@]}" -gt 0 ]; then
  echo "  · 视频源：${VISION_ARGS[*]}"
fi
# 注意：macOS 自带的 bash 3.2 在 set -u 下展开「空数组」会报 unbound，所以用 ${A[@]+"${A[@]}"}
up vision "$ROOT" python3 -u -m vision.main ${VISION_ARGS[@]+"${VISION_ARGS[@]}"}
sleep 4
grep -m1 'VLM       :' "$LOG_DIR/vision.log" || echo "  [!] 视觉模块还没打印启动信息，看 $LOG_DIR/vision.log" >&2

echo "== 4/4  桌宠 Electron =="
up pet "$ROOT/desktop" npm run pet
sleep 2

echo
echo "== 状态 =="
for p in / /live /pet; do
  printf '  %-6s HTTP %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$FRONTEND_PORT$p")"
done
echo -n "  观察记录："
curl -s "http://127.0.0.1:$BACKEND_PORT/species-card" || echo "（B 取不到，看日志）"
echo
if [ -n "$LAN_IP" ]; then
  echo "  手机访问（同一 WiFi）：http://$LAN_IP:$FRONTEND_PORT/live"
  echo "    · 面板轮询的是 http://${LAN_IP}:${BACKEND_PORT}（已内联进前端 + 已进 CORS 白名单）"
  echo "    · 首次可能弹「是否允许 Python / node 接受连接」→ 必须允许，否则手机连不上"
  echo "    · / 页要调摄像头，iOS 在 http:// 下不给权限（需 HTTPS），用 /live 不受影响"
  # 自检：Next 16 会 403 掉「跨源」的 dev 私有资源（/_next/*）。被拦的话手机拿到 HTML 却加载不到
  # dev chunk → hydration 起不来 → 页面「能看不能点」。这里主动用手机的请求头验一下（见 6.6 节）。
  DEV_PROBE="$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Referer: http://$LAN_IP:$FRONTEND_PORT/live" \
    -H 'Sec-Fetch-Mode: no-cors' -H 'Sec-Fetch-Site: cross-site' \
    "http://$LAN_IP:$FRONTEND_PORT/_next/hmr" 2>/dev/null || true)"
  if [ "$DEV_PROBE" = "403" ]; then
    echo "  [!] 手机的 dev 资源被 Next 拦了（HTTP 403）→ 页面会「能看不能点」！" >&2
    echo "      检查 frontend/next.config.ts 的 allowedDevOrigins，然后重启前端（见 README 6.6 / 7 节）" >&2
  else
    echo "    · dev 资源自检：HTTP ${DEV_PROBE:-无响应}（不是 403 就正常，手机不会变死页）"
  fi
else
  echo "  只本机可访问；想让手机打开就带 LAN=1 重启（见 README 6.6 节）"
fi
echo "  日志：$LOG_DIR/{backend,frontend,vision,pet}.log"
echo "  停服：./scripts/dev-down.sh"
