/** @type {import('next').NextConfig} */
const nextConfig = {
  // 方式 1：Next.js 14 官方推荐的排除方式
  experimental: {
    serverComponentsExternalPackages: ['pino', 'pino-pretty', 'thread-stream'],
  },
  // 方式 2：强行修改 Webpack 配置，把 pino 及其依赖彻底设为外部引用
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals.push('pino', 'pino-pretty', 'thread-stream');
    }
    return config;
  },
  // 忽略各种检查以提速
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
