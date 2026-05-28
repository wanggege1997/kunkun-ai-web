import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 允许在服务端使用Prisma
  serverExternalPackages: ["@prisma/client", "prisma"],
  // 图片域名白名单（按需添加）
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "dundun2026.oss-cn-guangzhou.aliyuncs.com",
      },
      {
        protocol: "https",
        hostname: "*.runninghub.cn",
      },
    ],
  },
};

export default nextConfig;
