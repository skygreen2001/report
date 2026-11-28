/** @type {import('next').NextConfig} */
const nextConfig = {
  // 不用 basePath：应用目录前缀靠 middleware rewrite 处理（见 doc §2.2 坑1）
  reactStrictMode: true,
  // 生产部署产物收敛为自包含 standalone（node server.js 即可运行）
  output: 'standalone',
  // mysql2 / exceljs / sql.js 是纯 Node 包，确保不被打包进 Edge/客户端
  serverExternalPackages: ['mysql2', 'exceljs', 'node-sql-parser', 'sql.js'],
  // sql.js 的 wasm 通过 fs 读取，需显式纳入产物追踪
  outputFileTracingIncludes: {
    '/**': ['node_modules/sql.js/package.json', 'node_modules/sql.js/dist/sql-wasm.js', 'node_modules/sql.js/dist/sql-wasm.wasm'],
    '/*': ['node_modules/sql.js/package.json', 'node_modules/sql.js/dist/sql-wasm.js', 'node_modules/sql.js/dist/sql-wasm.wasm'],
  },
};

export default nextConfig;
