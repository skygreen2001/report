// M3~M6 服务层 live 验证（不依赖 Next）：标签树 / 双轨生命周期 / 协作需求 / 审计 / 应用管理。
// 编译：node node_modules/typescript/bin/tsc -p tsconfig.verify.json
// 运行：node -r ./scripts/alias.cjs .verify-build/scripts/verify-lifecycle.js
import fs from 'fs';
import { pGet, pQuery, pRun } from '@/server/db/platform';
import { defaultSettings } from '@/server/context';
import { encrypt } from '@/server/crypto';
import { createApplication, disableApplication } from '@/server/services/application';
import { createNode, renameNode, getRoot, getRecycleBin, listNodes } from '@/server/services/tagTree';
import { getDefaultWorkspace } from '@/server/services/devWorkspace';
import { saveReport, listReports } from '@/server/services/report';
import { deleteReport, restoreReport, purge, restoreClientVisibility } from '@/server/services/lifecycle';
import { createRequirement, listInbox, listMine, completeRequirement, confirmRequirement } from '@/server/services/requirement';
import { HttpError } from '@/server/errors';
import type { RoleContext } from '@/lib/types';

function loadEnv() {
  const txt = fs.readFileSync('.env.local', 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); }
}
function expectCode(fn: () => Promise<unknown>, code: string, label: string) {
  return fn().then(
    () => ok(false, label, `期望 ${code} 但没抛错`),
    (e: any) => ok(e?.code === code, label, `实际 ${e?.code ?? e?.message}`),
  );
}

async function main() {
  loadEnv();

  // ---------- 准备：临时应用（不污染 demo） ----------
  const suffix = Date.now().toString(36);
  const appId = await createApplication({ name: `生命周期验证-${suffix}`, pathPrefix: `verify-${suffix}` });
  const app = (await pGet<any>('SELECT * FROM application WHERE id=?', [appId]))!;
  // 开发者工作区：隔离粒度是「应用 + 人」，验证脚本统一用甲方的 OWNER 工作区
  const ws = await getDefaultWorkspace(appId);
  // 自己的只读数据源（报表只能绑本应用的数据源，不能借用别的应用的）
  const dsId = `ds-${suffix}`;
  await pRun(
    `INSERT INTO data_source (id,app_id,ws_id,name,host,port,database_name,username,password_enc,status)
     VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE')`,
    [dsId, appId, ws.id, '只读库', '127.0.0.1', 3306, 'biz_demo', 'report_ro', encrypt('ReportRo@2026')],
  );
  const ds = (await pGet<any>('SELECT * FROM data_source WHERE id=?', [dsId]))!;

  const base = { appId, settings: defaultSettings(), app, wsId: ws.id, wsKey: ws.ws_key } as const;
  const dev: RoleContext = { ...base, role: 'DEVELOPER', clientKey: 'dev-1' };
  const cli: RoleContext = { ...base, role: 'CLIENT', clientKey: 'cli-1' };

  console.log('=== M3 标签树（REQ-TAG-01/03/07）===');
  const devRoot = (await getRoot(appId, 'DEVELOPER', ws.id))!;
  const cliRoot = (await getRoot(appId, 'CLIENT', null))!;
  const devBin = (await getRecycleBin(appId, 'DEVELOPER', ws.id))!;
  ok(!!devRoot && !!cliRoot && !!devBin, '初始化出两棵树 + 回收站');
  ok((await listNodes(appId, 'CLIENT', null)).length === 2, 'CLIENT 树初始 2 个系统节点');

  // 深度限制：ROOT(1) → d1(2) → d2(3) → d3(4) → d4(5)，第 6 层应拒
  let p = devRoot.id;
  const dirs: string[] = [];
  for (let i = 0; i < 4; i++) { p = await createNode(appId, 'DEVELOPER', ws.id, `目录${i + 1}`, p); dirs.push(p); }
  ok(dirs.length === 4, '连续建 4 层子目录成功');
  await expectCode(() => createNode(appId, 'DEVELOPER', ws.id, '超深目录', dirs[3]), 'MAX_DEPTH_EXCEEDED', '第 6 层目录被拒（MAX_DEPTH=5）');
  await expectCode(() => createNode(appId, 'DEVELOPER', ws.id, '回收站下', devBin.id), 'CANNOT_ADD_UNDER_BIN', '回收站下建目录被拒');
  await expectCode(() => renameNode(appId, 'DEVELOPER', ws.id, devRoot.id, '改名'), 'SYSTEM_NODE_IMMUTABLE', '重命名系统节点被拒');
  await renameNode(appId, 'DEVELOPER', ws.id, dirs[0], '目录一改名');
  ok((await pGet<any>('SELECT name FROM tag_node WHERE id=?', [dirs[0]]))!.name === '目录一改名', '普通目录可重命名');

  console.log('\n=== M3 双轨生命周期（REQ-SAVE-02 / REQ-LIFE-02/04/06/07/16）===');
  // 保存时先过网关前两道闸：非法 SQL 当场拒，不入库
  await expectCode(
    () => saveReport(dev, { name: '非法', sqlText: 'DROP TABLE orders', dataSourceId: ds.id }),
    'STMT_NOT_READONLY', '保存 DROP 被拒（不入库）',
  );
  await expectCode(
    () => saveReport(dev, { name: '非法2', sqlText: 'SELECT SLEEP(5)', dataSourceId: ds.id }),
    'DANGEROUS_FUNCTION', '保存 SLEEP 被拒（不入库）',
  );
  const otherDs = await pGet<any>(
    'SELECT id FROM data_source WHERE app_id=(SELECT id FROM application WHERE path_prefix=?) LIMIT 1', ['demo'],
  );
  if (otherDs) {
    await expectCode(
      () => saveReport(dev, { name: '越权', sqlText: 'SELECT 1', dataSourceId: otherDs.id }),
      'FORBIDDEN', '不能绑定别的应用的数据源',
    );
  }
  const reportId = await saveReport(dev, {
    name: `验证报表-${suffix}`,
    sqlText: 'SELECT region, COUNT(*) AS cnt FROM orders GROUP BY region',
    dataSourceId: ds.id,
    parentNodeId: dirs[1],
  });
  const pls = await pQuery<any>('SELECT * FROM report_placement WHERE report_id=?', [reportId]);
  ok(pls.length === 2, '保存即两棵树各一条 placement', `role=${pls.map((x) => x.role).join('/')}`);
  const cliPl = pls.find((x) => x.role === 'CLIENT')!;
  const devPl = pls.find((x) => x.role === 'DEVELOPER')!;
  ok(devPl.tag_node_id === dirs[1], '开发者侧落在指定目录');
  ok(cliPl.tag_node_id === cliRoot.id, '甲方侧落在甲方根目录');

  // 甲方删除 → 仅甲方进入回收站，开发者仍 NORMAL
  await deleteReport(cli, reportId);
  let r = (await pGet<any>('SELECT * FROM report WHERE id=?', [reportId]))!;
  ok(r.client_state === 'RECYCLED' && r.developer_state === 'NORMAL', '甲方删除：client=RECYCLED，developer=NORMAL（双轨独立）');
  ok((await pQuery('SELECT 1 FROM report_placement WHERE report_id=? AND role=? AND tag_node_id=?', [reportId, 'CLIENT', cliRoot.id])).length === 0, '甲方侧已移出原目录');
  const cliBin0 = (await getRecycleBin(appId, 'CLIENT', null))!;
  const cliPlBin = (await pGet<any>('SELECT * FROM report_placement WHERE report_id=? AND role=?', [reportId, 'CLIENT']))!;
  ok(cliPlBin.tag_node_id === cliBin0.id, '甲方侧落入甲方回收站节点（回收站内容必须可列出）');
  ok((await listReports(dev)).some((x: any) => x.id === reportId), '开发者列表仍可见该报表');
  ok((await listReports(cli)).some((x: any) => x.id === reportId && x.tag_node_id === cliBin0.id), '甲方仍可见，但挂在回收站下');

  // 甲方还原 → 回到原父目录
  await restoreReport(cli, reportId);
  r = (await pGet<any>('SELECT * FROM report WHERE id=?', [reportId]))!;
  const cliPl2 = (await pGet<any>('SELECT * FROM report_placement WHERE report_id=? AND role=?', [reportId, 'CLIENT']))!;
  ok(r.client_state === 'NORMAL', '甲方还原后 client_state=NORMAL');
  ok(cliPl2.tag_node_id === cliRoot.id, '还原回原父目录（origin_parent_id 生效）');

  // 甲方清空 → client=PURGED，开发者仍可见（REQ-LIFE-07）
  await purge(cli, [reportId]);
  r = (await pGet<any>('SELECT * FROM report WHERE id=?', [reportId]))!;
  ok(r.client_state === 'PURGED', '甲方清空：client_state=PURGED');
  ok((await listReports(dev)).some((x: any) => x.id === reportId), '开发者仍可见（甲方清空不物理删除）');
  ok(!(await listReports(cli)).some((x: any) => x.id === reportId), '甲方不可见');

  // 开发者恢复甲方可见 → 落入甲方回收站（REQ-LIFE-16）
  await restoreClientVisibility(dev, reportId);
  r = (await pGet<any>('SELECT * FROM report WHERE id=?', [reportId]))!;
  const cliBin = (await getRecycleBin(appId, 'CLIENT', null))!;
  const cliPl3 = (await pGet<any>('SELECT * FROM report_placement WHERE report_id=? AND role=?', [reportId, 'CLIENT']))!;
  ok(r.client_state === 'RECYCLED', '恢复甲方可见：client_state=RECYCLED');
  ok(cliPl3.tag_node_id === cliBin.id, '落入甲方回收站');

  // 重复清空幂等 + 非回收站还原被拒
  await expectCode(() => restoreReport(dev, reportId), 'NOT_IN_RECYCLE_BIN', '开发者侧不在回收站 → 还原被拒');

  // 开发者清空（宽限 0 天）→ 物理删除，子表全部级联
  const dev0: RoleContext = { ...dev, settings: { ...dev.settings, purgeGraceDays: 0 } };
  await purge(dev0, [reportId]);
  ok(!(await pGet('SELECT id FROM report WHERE id=?', [reportId])), '开发者清空（grace=0）：report 行已物理删除');
  const leftover = await pQuery<any>(
    `SELECT 'placement' t, COUNT(*) c FROM report_placement WHERE report_id=?
     UNION ALL SELECT 'sql_version', COUNT(*) FROM sql_version WHERE report_id=?
     UNION ALL SELECT 'requirement', COUNT(*) FROM requirement WHERE report_id=?`,
    [reportId, reportId, reportId],
  );
  ok(leftover.every((x: any) => Number(x.c) === 0), 'placement/sql_version/requirement 全部级联删除', JSON.stringify(leftover.map((x: any) => `${x.t}=${x.c}`)));

  console.log('\n=== M4 协作需求（REQ-COL-01/04/05/07）===');
  const rep2 = await saveReport(dev, { name: `协作报表-${suffix}`, sqlText: 'SELECT * FROM orders LIMIT 10', dataSourceId: ds.id });

  const cliOnly: RoleContext = { ...cli, clientKey: 'cli-A' };
  const reqId = await createRequirement(cliOnly, { prompt: '想看华东的订单明细', reportId: rep2 });
  ok((await listInbox(dev)).some((x: any) => x.id === reqId), '开发者收件箱可见甲方需求');
  const mineA = await listMine(cliOnly);
  ok(mineA.some((x: any) => x.id === reqId), '甲方只见自己提交的需求');
  const cliB: RoleContext = { ...cli, clientKey: 'cli-B' };
  ok(!(await listMine(cliB)).some((x: any) => x.id === reqId), '另一位甲方看不到（client_key 隔离）');

  await completeRequirement(dev, reqId);
  ok((await pGet<any>('SELECT status FROM requirement WHERE id=?', [reqId]))!.status === 'PENDING_CONFIRM', '开发者完成 → PENDING_CONFIRM');
  await expectCode(() => confirmRequirement(dev, reqId, true), 'FORBIDDEN', '开发者不能代替甲方确认');
  await confirmRequirement(cliOnly, reqId, true);
  ok((await pGet<any>('SELECT status FROM requirement WHERE id=?', [reqId]))!.status === 'CONFIRMED', '甲方确认 → CONFIRMED');

  console.log('\n=== M5 审计（REQ-AUD-01）===');
  const audits = await pQuery<any>('SELECT action, COUNT(*) c FROM audit_log WHERE app_id=? GROUP BY action ORDER BY action', [appId]);
  ok(audits.length > 0, '审计日志已落库', audits.map((a: any) => `${a.action}×${a.c}`).join(' '));

  console.log('\n=== M6 应用管理（REQ-ACC-10/13）===');
  const rootApp = (await pGet<any>('SELECT * FROM application WHERE is_platform_root=1'))!;
  const rootWs = await getDefaultWorkspace(rootApp.id);
  const rootCtx: RoleContext = {
    appId: rootApp.id, role: 'DEVELOPER', clientKey: 'root', settings: defaultSettings(), app: rootApp,
    wsId: rootWs.id, wsKey: rootWs.ws_key,
  };
  await expectCode(() => disableApplication(dev, rootApp.id), 'NOT_PLATFORM_ROOT', '非平台根应用不能停用别的应用');
  await expectCode(() => disableApplication(rootCtx, rootApp.id), 'CANNOT_DISABLE_ROOT', '平台根应用自身不可停用');
  await disableApplication(rootCtx, appId);
  ok((await pGet<any>('SELECT status FROM application WHERE id=?', [appId]))!.status === 'DISABLED', '平台根可停用普通应用');

  // 清理本轮临时数据（审计/需求/节点/数据源/报表/应用）
  await pRun('DELETE FROM audit_log WHERE app_id=?', [appId]);
  await pRun('DELETE FROM requirement WHERE app_id=?', [appId]);
  await pRun('DELETE FROM report_placement WHERE report_id IN (SELECT id FROM report WHERE app_id=?)', [appId]);
  await pRun('DELETE FROM sql_version WHERE app_id=?', [appId]);
  await pRun('DELETE FROM report WHERE app_id=?', [appId]);
  await pRun('DELETE FROM tag_node WHERE app_id=?', [appId]);
  await pRun('DELETE FROM data_source WHERE app_id=?', [appId]);
  await pRun('DELETE FROM application WHERE id=?', [appId]);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('VERIFY-LIFECYCLE ERROR:', e); process.exit(1); });
