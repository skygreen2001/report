/** @type {import('next').NextConfig} */
const nextConfig = {
  // 不用 basePath：应用目录前缀靠 middleware rewrite 处理（见 doc §2.2 坑1）
  reactStrictMode: true,
  // mysql2 / exceljs 是纯 Node 包，确保不被打包进 Edge/客户端
  serverExternalPackages: ['mysql2', 'exceljs', 'node-sql-parser'],
};

export default nextConfig;
