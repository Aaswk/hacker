#!/usr/bin/env python3
"""RTSP 中继（TCP 透传）—— 用来复现「手机流忽然断了，C 会怎么样」。

为什么需要它：6.5 节实测过「断流后 C 不自动重连，约 1 秒退出、退出码 4」，
但真去拔手机 / 让手机锁屏来复现很麻烦，而且没法量化。这个中继让你把 C 指到
`127.0.0.1`，然后**随时掐掉中继**，对 C 而言等价于手机 App 退到后台 / 掉 WiFi
（本仓库实测的 IP 摄像头 App 走的是 RTSP-over-TCP，所以 TCP 透传就够了；
即使 C 用 UDP 建流，掐掉 TCP 信号通道同样会让流中断）。

用法：

    # ① 起中继：本机 8555 → 手机 8554
    python3 scripts/rtsp-relay.py --target 192.168.11.12:8554 &

    # ② 让 C 读中继（地址里的 host/port 换成中继的，路径保持手机原来的）
    python3 -u -m vision.main --source rtsp://127.0.0.1:8555/live </dev/null

    # ③ 等 C 正常跑起来（日志出现「[Video] 实际分辨率 …」）后，掐掉中继
    pkill -f 'rtsp-relay[.]py'
    # 观察 C 的日志：约 1 秒后会打印
    #   [错误] 连续 60 帧读取失败，退出。      ← 退出码 4，不自动重连

退出：Ctrl+C，或 `pkill -f 'rtsp-relay[.]py'`。
"""

from __future__ import annotations

import argparse
import socket
import threading

BUF_SIZE = 65536


def pump(src: socket.socket, dst: socket.socket) -> None:
    """单向搬运字节；任一端断开就把两端都关掉，让对端立刻感知（而不是干等超时）。"""
    try:
        while True:
            data = src.recv(BUF_SIZE)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for sock in (src, dst):
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass


def handle(client: socket.socket, target: tuple[str, int]) -> None:
    try:
        upstream = socket.create_connection(target, timeout=5)
    except OSError as exc:
        print(f"[relay] 连不上上游 {target[0]}:{target[1]} —— {exc}", flush=True)
        client.close()
        return
    print(f"[relay] 建立转发 {client.getpeername()} → {target[0]}:{target[1]}", flush=True)
    threading.Thread(target=pump, args=(client, upstream), daemon=True).start()
    threading.Thread(target=pump, args=(upstream, client), daemon=True).start()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="RTSP TCP 中继：把 C 指到本机，再掐掉中继，复现手机流中断"
    )
    parser.add_argument("--listen-host", default="127.0.0.1", help="监听地址，默认 127.0.0.1")
    parser.add_argument("--listen-port", type=int, default=8555, help="监听端口，默认 8555")
    parser.add_argument(
        "--target",
        required=True,
        help="上游「手机IP:端口」，例如 192.168.11.12:8554",
    )
    return parser.parse_args(argv)


def parse_target(raw: str) -> tuple[str, int]:
    host, _, port = raw.rpartition(":")
    if not host or not port.isdigit():
        raise SystemExit(f"--target 要写成「主机:端口」，收到的是：{raw}")
    return host, int(port)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    target = parse_target(args.target)

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((args.listen_host, args.listen_port))
    server.listen(4)

    print(
        f"RTSP 中继已启动：{args.listen_host}:{args.listen_port} → {target[0]}:{target[1]}"
    )
    print(f"  让 C 读：python3 -u -m vision.main --source rtsp://{args.listen_host}:{args.listen_port}/live </dev/null")
    print("  复现断流：跑起来之后 pkill -f 'rtsp-relay[.]py'，看 C 的日志怎么反应")
    print("  收尾：    pkill -f 'rtsp-relay[.]py'")
    try:
        while True:
            client, _ = server.accept()
            threading.Thread(target=handle, args=(client, target), daemon=True).start()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        server.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
