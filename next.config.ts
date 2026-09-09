import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next 16 dev 来源保护：通过局域网 IP 访问 dev server（如手机/其他设备调试）时，
  // 需显式允许该 origin，否则 HTML 可达但 CSS/JS/HMR 被拒（页面无样式）。
  // 本机访问 localhost 不受影响；新增访问地址时在这里追加。
  allowedDevOrigins: ["http://10.32.80.156:3000", "http://10.32.80.156"],
};

export default nextConfig;
