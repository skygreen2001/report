// 扁平化迁移：去掉 OWNER 工作区层级，所有行归到应用的「默认工作区」（第一个 DEVELOPER 工作区）。
// 幂等，可重复执行。
//
// 运行：
//   env -u NODE_OPTIONS /Users/skygreen/.workbuddy/binaries/node/versions/22.12.0/bin/node \
//     node_modules/tsx/dist/cli.mjs scripts/migrate-ws-flatten.ts

import { pGet, pQuery, pRun } from '@/server/db/platform';
import fs from 'node:fs';

function loadEnv(): void {
  try {
    const txt = fs.readFileSync('.env.local', 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
      if (m) process.env[m[1]] = m[2].trim();
    }
  } catch { /* 外部已注入则忽略 */ }
}

async function main(): Promise<void> {
  loadEnv();
  const apps = await pQuery<any>('SELECT * FROM application ORDER BY created_at');
  for (const app of apps) {
    const def = await pGet<any>(
      "SELECT * FROM dev_workspace WHERE app_id=? ORDER BY created_at LIMIT 1", [app.id],
    );
    if (!def) {
      console.log(`[${app.path_prefix}] 无工作区，跳过`);
      continue;
    }
    const owners = await pQuery<any>(
      "SELECT * FROM dev_workspace WHERE app_id=? AND kind='OWNER'", [app.id],
    );
    for (const o of owners) {
      // 把 OWNER 工作区里残留的配置并到默认工作区（demo/早期数据可能落在 OWNER 上）
      await pRun('UPDATE data_source SET ws_id=? WHERE app_id=? AND ws_id=?', [def.id, app.id, o.id]);
      await pRun('UPDATE report SET ws_id=? WHERE app_id=? AND ws_id=?', [def.id, app.id, o.id]);
      // tag_node 的系统节点(ROOT/回收站)与默认工作区唯一键冲突，直接删 OWNER 那棵（默认工作区自带的即可）
      await pRun('DELETE FROM tag_node WHERE app_id=? AND ws_id=?', [app.id, o.id]);
      await pRun('UPDATE llm_provider SET ws_id=? WHERE app_id=? AND ws_id=?', [def.id, app.id, o.id]);
      await pRun('DELETE FROM dev_workspace WHERE id=?', [o.id]);
      console.log(`[${app.path_prefix}] 合并 OWNER 工作区 → 默认工作区 ${def.name}`);
    }
    // 兜底：所有模型配置都挂到默认工作区（字段曾按 OWNER 存过）
    await pRun('UPDATE llm_provider SET ws_id=? WHERE app_id=?', [def.id, app.id]);
    const ds = await pGet<any>('SELECT COUNT(*) c FROM data_source WHERE app_id=? AND ws_id=?', [app.id, def.id]);
    const rep = await pGet<any>('SELECT COUNT(*) c FROM report WHERE app_id=? AND ws_id=?', [app.id, def.id]);
    console.log(`[${app.path_prefix}] 默认工作区「${def.name}」：数据源 ${ds?.c ?? 0}，报表 ${rep?.c ?? 0}`);
  }
  console.log('\n完成。');
  process.exit(0);
}

main().catch((e) => { console.error('迁移失败：', e); process.exit(1); });
