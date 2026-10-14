// 迁移：引入「浏览器身份」模型。
//   · dev_workspace 增加 claimed 列（0=尚未归属任何浏览器，首次访问即认领）。
//   · 存量工作区全部置为 claimed=0 → 第一个打开页面的浏览器会认领它，老配置不丢失。
// 幂等，可重复执行。
//
// 运行：
//   env -u NODE_OPTIONS /Users/skygreen/.workbuddy/binaries/node/versions/22.12.0/bin/node \
//     node_modules/tsx/dist/cli.mjs scripts/migrate-ws-browser-identity.ts

import fs from 'node:fs';
import { pGet, pQuery, pRun } from '@/server/db/platform';

function loadEnv(): void {
  try {
    const txt = fs.readFileSync('.env.local', 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
      if (m) process.env[m[1]] = m[2].trim();
    }
  } catch { /* 外部已注入则忽略 */ }
}

async function hasColumn(table: string, col: string): Promise<boolean> {
  const r = await pGet<any>(
    `SELECT COUNT(*) AS c FROM information_schema.columns
     WHERE table_schema=DATABASE() AND table_name=? AND column_name=?`,
    [table, col],
  );
  return Number(r?.c ?? 0) > 0;
}

async function main(): Promise<void> {
  loadEnv();

  if (!(await hasColumn('dev_workspace', 'claimed'))) {
    await pRun('ALTER TABLE dev_workspace ADD COLUMN claimed TINYINT(1) NOT NULL DEFAULT 0');
    console.log('  + dev_workspace.claimed');
  }

  // 存量一律待认领：谁先打开页面谁认领（保证升级后老配置还在第一个使用者手里）
  await pRun('UPDATE dev_workspace SET claimed=0');
  console.log('  ~ 所有存量工作区置为 claimed=0（等待浏览器认领）');

  const rows = await pQuery<any>(
    `SELECT w.*, a.path_prefix FROM dev_workspace w JOIN application a ON a.id=w.app_id
     ORDER BY a.path_prefix, w.created_at`,
  );
  console.log('\n=== 工作区清单 ===');
  for (const w of rows) {
    const ds = await pGet<any>('SELECT COUNT(*) c FROM data_source WHERE ws_id=?', [w.id]);
    const rep = await pGet<any>('SELECT COUNT(*) c FROM report WHERE ws_id=?', [w.id]);
    console.log(
      `  ${String(w.path_prefix).padEnd(10)} ${String(w.name).padEnd(12)} claimed=${w.claimed} 数据源=${ds?.c ?? 0} 报表=${rep?.c ?? 0}`,
    );
  }
  console.log('\n完成。');
  process.exit(0);
}

main().catch((e) => { console.error('迁移失败：', e); process.exit(1); });
