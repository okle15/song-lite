import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // APlayer 内部 DOM 操作与 React StrictMode 双挂载不兼容
  // （destroy 后 initializedRef 未重置导致无法重新初始化）
  reactStrictMode: false,
};

export default nextConfig;
