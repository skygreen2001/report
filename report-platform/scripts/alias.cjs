// 运行时 @/ 路径别名解析钩子（仅用于 verify 验证脚本，不在 Next 中使用）。
// tsc 在 CommonJS emit 时不会把 paths 别名改写成相对 require，故用 -r 注入此钩子，
// 将 require('@/server/db/platform') 映射到 .verify-build/src/server/db/platform.js。
const path = require('path');
const Module = require('module');

const BUILD_ROOT = path.resolve(__dirname, '..', '.verify-build');

const original = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (typeof request === 'string' && request.startsWith('@/')) {
    const rel = request.slice(2); // server/db/platform
    const base = path.join(BUILD_ROOT, 'src', rel);
    for (const ext of ['.js', '.cjs', '.json']) {
      const candidate = base + ext;
      try {
        return original.call(this, candidate, ...args);
      } catch (_) {
        // 尝试下一扩展名
      }
    }
  }
  return original.call(this, request, ...args);
};
