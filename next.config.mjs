/** @type {import('next').NextConfig} */
const nextConfig = {
  // 核心配置：将 pino 排除在 Webpack 打包之外
  experimental: {
    serverComponentsExternalPackages: ['pino', 'pino-pretty'],
  },
  // 如果你之前加了忽略报错的配置，也一起带上
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
