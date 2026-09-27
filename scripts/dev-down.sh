#!/usr/bin/env bash
# 人类观察站 · 停止全部组件
#
#   启动：  ./scripts/dev-up.sh
#   停止：  ./scripts/dev-down.sh
#
# 先按 dev-up.sh 留下的 pid 文件递归杀进程树（npm/nohup 包了一层，必须连子进程一起杀），
# 再用端口兜底（3000/8001，防止手工起过、没有 pid 文件的进程漏掉）。
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="/tmp/human-observatory"

# kill_tree <pid>：先杀子进程再杀自己，避免 nohup/npm 中间层留下孤儿
kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child"
  done
  if kill "$pid" 2>/dev/null; then
    echo "  · kill $pid"
  fi
}

echo "== 按 pid 文件停止 =="
for name in pet vision frontend backend; do
  pid_file="$RUN_DIR/$name.pid"
  if [ -f "$pid_file" ]; then
    pid="$(cat "$pid_file")"
    if kill -0 "$pid" 2>/dev/null; then
      echo "  $name (pid $pid)"
      kill_tree "$pid"
    else
      echo "  $name 早就退了（pid ${pid}）"
    fi
    rm -f "$pid_file"
  else
    echo "  $name 没有 pid 文件，跳过"
  fi
done

echo "== 按端口兜底 =="
for port in 3000 8001; do
  for pid in $(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null); do
    echo "  :$port 仍被 pid $pid 占用"
    kill_tree "$pid"
  done
done

echo "== 按进程特征兜底（手工起的、没有 pid 文件的） =="
# 模式都锚定到本仓库路径 / 本项目特征，避免误杀别的项目；用 [x] 写法避免匹配到本脚本自身
for pat in \
  "$ROOT/frontend/node_modules/[.]bin/next dev" \
  "$ROOT/desktop/node_modules/[.]bin/electron" \
  "$ROOT/desktop/node_modules/electron/dist/Electron[.]app" \
  "[-]m vision[.]main" \
  "[-]m uvicorn app:app"; do
  for pid in $(pgrep -f -- "$pat" 2>/dev/null); do
    [ "$pid" = "$$" ] && continue
    echo "  特征命中：pid $pid"
    kill_tree "$pid"
  done
done

sleep 3
echo "== 结果 =="
if lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -qE ':(3000|8001)'; then
  echo "  [!] 端口 3000/8001 仍有残留：" >&2
  lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(3000|8001)' >&2
  exit 1
fi
echo "  端口 3000/8001 已释放"
echo "  桌宠/视觉/前端/后端 已停止（若桌宠窗口还在，手动关掉或再跑一次本脚本）"
