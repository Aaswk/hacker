import type { NextConfig } from "next";

/**
 * 手机 / 局域网调试（见 README 6.6 节）——`allowedDevOrigins` 为什么必须配：
 *
 * Next 16 的 dev server 默认会**拦掉来自其它 host 的 dev 私有资源**（`/_next/*`、`/__nextjs*`），
 * 日志会打 `Blocked cross-origin request to Next.js dev resource /_next/hmr from "192.168.11.156"`，
 * 响应是 403 Unauthorized。手机用 `http://<Mac 的局域网 IP>:3000` 打开时必然中招：
 * **HTML 能出来，但 hydration 用的 dev chunk 被 403 掉 → 页面变成「死页」（按钮点不动、数据不刷新）**，
 * 而 Next 自己启动横幅还照样宣传 `Network: http://<那个 IP>:3000`，很容易被坑。
 *
 * 匹配规则（读的 Next 源码 `server/app-render/csrf-protection.js`）：拿 Origin/Referer 的
 * **纯主机名**（不带协议、不带端口）去比，**按点分段**通配 —— `*` 匹配一段，`**` 匹配剩下的所有段，
 * 单独一个 `*` / `**` 会被拒绝（不允许通配整个域名）。所以 `192.168.11.*` 只覆盖一个 /24。
 *
 * 只影响 `next dev`；`next build && next start`（生产模式）不读它、也不需要它。
 */
const lanDevHosts = [
  "127.0.0.1",
  "[::1]",
  "::1",
  "*.local", // mDNS，例如 syyzdeMacBook-Pro.local
  "10.*.*.*", // 企业 / VPN 常见的私网（10.0.0.0/8）
  "192.168.*.*", // 家庭 & 办公室最常见的私网（192.168.0.0/16）——手机连同一 WiFi 就在这段里
  "172.16.*.*", // 私网 172.16.0.0/12 的第一段，其余段按需往 ALLOWED_DEV_ORIGINS 里加
];

/**
 * 额外放行别的 host（Mac 换了子网、Tailscale MagicDNS、自定义域名…）：
 *
 *   ALLOWED_DEV_ORIGINS=mac.tailnet.ts.net,192.168.50.7 ./scripts/dev-up.sh
 *
 * `LAN=1 ./scripts/dev-up.sh` 会自动把当前局域网 IP 也塞进来（双保险）。
 * 这里宽容地接受 `http://x:3000/` 这种写法，自动去掉协议、端口、路径。
 */
const extraDevHosts = (process.env.ALLOWED_DEV_ORIGINS ?? "")
  .split(",")
  .map((host) =>
    host
      .trim()
      .replace(/^[a-z]+:\/\//i, "")
      .replace(/\/.*$/, "")
      .replace(/:\d+$/, "")
      .toLowerCase(),
  )
  .filter(Boolean);

const nextConfig: NextConfig = {
  allowedDevOrigins: [...lanDevHosts, ...extraDevHosts],
};

export default nextConfig;
