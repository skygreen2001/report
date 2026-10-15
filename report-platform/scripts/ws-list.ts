// 列出所有「开发者工作区」及其身份 key（ws_key）—— 换设备 / 备份身份时用。
//
// 运行：
//   env -u NODE_OPTIONS /Users/skygreen/.workbuddy/binaries/node/versions/22.12.0/bin/node \
//     node_modules/tsx/dist/cli.mjs scripts/ws-list.ts

import fs from 'node:fs';
import { pQuery } from '@/server/db/platform';

function loadEnv(): void {
  try {
    for (const line of fs.readFileSync('.env.local', 'utf8').split('\n')) {
      const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
      if (m) process.env[m[1]] = m[2].trim();
    }
  } catch { /* 环境变量已由外部注入时忽略 */ }
}

async function main(): Promise<void> {
  loadEnv();
  const rows = await pQuery<any>(
    `SELECT w.id, w.ws_key, w.name, w.claimed, w.status, w.created_at, a.path_prefix,
            (SELECT COUNT(*) FROM data_source d WHERE d.ws_id=w.id) AS ds_count,
            (SELECT COUNT(*) FROM report r WHERE r.ws_id=w.id AND r.developer_state='NORMAL') AS report_count
     FROM dev_workspace w JOIN application a ON a.id=w.app_id
     ORDER BY a.path_prefix, w.created_at`,
  );
  console.log('\n应用        名称           状态      认领  数据源 报表  ws_key');
  console.log('----------------------------------------------------------------------------------');
  for (const r of rows) {
    console.log(
      `${String(r.path_prefix).padEnd(11)} ${String(r.name).padEnd(14)} ${String(r.status).padEnd(9)} ${String(r.claimed).padEnd(5)} ${String(r.ds_count).padEnd(6)} ${String(r.report_count).padEnd(4)} ${r.ws_key}`,
    );
  }
  console.log('\n换设备时用这个链接把身份搬过去：');
  for (const r of rows) {
    console.log(`  /${r.path_prefix}/d?ws=${r.ws_key}`);
  }
  console.log('\n（认领列：0 = 还没被任何浏览器认领，第一个打开 /d 的浏览器会接管它并把 key 换成自己的）');
  process.exit(0);
}

main().catch((e) => { console.error('查询失败：', e); process.exit(1); });
