// 元库启动初始化：建表 + 平台根应用。
// 部署环境没有手工 seed 的机会，首个请求到达时自动完成（重复调用只跑一次）。
import { initPlatformDb } from './platform';

const g = globalThis as unknown as { __platformReady?: Promise<void> };

export function ensurePlatformReady(): Promise<void> {
  if (!g.__platformReady) {
    g.__platformReady = (async () => {
      await initPlatformDb();
      // 动态引入，避免 db 层与业务层形成静态循环依赖
      const { ensurePlatformRoot } = await import('../services/application');
      await ensurePlatformRoot();
    })().catch((e) => {
      g.__platformReady = undefined;
      throw e;
    });
  }
  return g.__platformReady;
}
