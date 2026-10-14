// NL2SQL 在线冒烟（M2）：真实调用 DeepSeek 端点生成 SQL，并用网关预览验证可安全执行。
// 运行（需先 tsc 编译）：node -r ./scripts/alias.cjs .verify-build/scripts/smoke-nl2sql.js
import fs from 'fs';
import { pGet } from '@/server/db/platform';
import { loadDataSource } from '@/server/services/datasource';
import { generateSql } from '@/server/services/generation';
import { execute } from '@/server/sql/gateway';
import { defaultSettings } from '@/server/context';
import { getDefaultWorkspace } from '@/server/services/devWorkspace';
import type { RoleContext } from '@/lib/types';

function loadEnv() {
  const txt = fs.readFileSync('.env.local', 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

async function main() {
  loadEnv();
  const app = await pGet<any>('SELECT * FROM application WHERE path_prefix=?', ['demo']);
  if (!app) throw new Error('未找到 demo 应用');
  const dsRow = await pGet<any>('SELECT * FROM data_source WHERE app_id=?', [app.id]);
  const ds = await loadDataSource(dsRow.id);
  const ws = await getDefaultWorkspace(app.id);
  const ctx: RoleContext = {
    appId: app.id, role: 'DEVELOPER', clientKey: 'smoke', settings: defaultSettings(), app,
    wsId: ws.id,
  };

  console.log('=== M2 NL2SQL 在线生成（DeepSeek）===');
  const res = await generateSql(ctx, {
    prompt: '统计各地区订单的总金额和订单数，按总金额降序',
    dataSourceId: ds.id,
  });
  console.log('mode:', res.mode);
  if (res.sql) console.log('生成 SQL:\n' + res.sql);
  if (res.reason) console.log('降级原因:', res.reason);

  if (res.sql) {
    console.log('\n=== 用 SQL 网关预览验证生成结果可安全执行 ===');
    const r = await execute(ds, res.sql, {}, { maxRows: 200, timeoutMs: 15000, source: 'PREVIEW', ctx });
    console.log('columns:', r.columns.join(', '), '| 行数:', r.rows.length);
    console.log(r.rows.map((x: any) => '  ' + JSON.stringify(x)).join('\n'));
  }
  console.log('\n✅ NL2SQL 冒烟完成。');
  process.exit(0);
}

main().catch((e) => { console.error('NL2SQL SMOKE ERROR:', e); process.exit(1); });
