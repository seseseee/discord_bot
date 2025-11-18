/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // transformes をサーバ側から動的 import できるように
    serverComponentsExternalPackages: ['@xenova/transformers'],
  },
  webpack: (config) => {
    // 不要なネイティブ依存をバンドルしない（存在しても無視）
    config.externals.push({
      'onnxruntime-node': 'commonjs onnxruntime-node',
      sharp: 'commonjs sharp',
    });
    return config;
  },
};
module.exports = nextConfig;
