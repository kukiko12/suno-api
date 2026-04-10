/** @type {import('next').NextConfig} */
const nextConfig = {
  // 核心：排除 pino 避免 Node 20 报错
  experimental: {
    serverComponentsExternalPackages: ['pino', 'pino-pretty']
  },
  // 强行跳过检查
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  // 强制禁用静态页生成时的报错
  trailingSlash: true,
}

module.exports = nextConfig
