"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// M3~M6 服务层 live 验证（不依赖 Next）：标签树 / 双轨生命周期 / 协作需求 / 审计 / 应用管理。
// 编译：node node_modules/typescript/bin/tsc -p tsconfig.verify.json
// 运行：node -r ./scripts/alias.cjs .verify-build/scripts/verify-lifecycle.js
const fs_1 = __importDefault(require("fs"));
const platform_1 = require("@/server/db/platform");
const context_1 = require("@/server/context");
const crypto_1 = require("@/server/crypto");
const application_1 = require("@/server/services/application");
const tagTree_1 = require("@/server/services/tagTree");
const report_1 = require("@/server/services/report");
const lifecycle_1 = require("@/server/services/lifecycle");
const requirement_1 = require("@/server/services/requirement");
function loadEnv() {
    const txt = fs_1.default.readFileSync('.env.local', 'utf8');
    for (const line of txt.split('\n')) {
        const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
        if (m)
            process.env[m[1]] = m[2].trim();
    }
}
let pass = 0;
let fail = 0;
function ok(cond, label, extra = '') {
    if (cond) {
        pass++;
        console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`);
    }
    else {
        fail++;
        console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`);
    }
}
function expectCode(fn, code, label) {
    return fn().then(() => ok(false, label, `期望 ${code} 但没抛错`), (e) => ok(e?.code === code, label, `实际 ${e?.code ?? e?.message}`));
}
async function main() {
    loadEnv();
    // ---------- 准备：临时应用（不污染 demo） ----------
    const suffix = Date.now().toString(36);
    const appId = await (0, application_1.createApplication)({ name: `生命周期验证-${suffix}`, pathPrefix: `verify-${suffix}` });
    const app = (await (0, platform_1.pGet)('SELECT * FROM application WHERE id=?', [appId]));
    // 自己的只读数据源（报表只能绑本应用的数据源，不能借用别的应用的）
    const dsId = `ds-${suffix}`;
    await (0, platform_1.pRun)(`INSERT INTO data_source (id,app_id,name,host,port,database_name,username,password_enc,status)
     VALUES (?,?,?,?,?,?,?,?,'ACTIVE')`, [dsId, appId, '只读库', '127.0.0.1', 3306, 'biz_demo', 'report_ro', (0, crypto_1.encrypt)('ReportRo@2026')]);
    const ds = (await (0, platform_1.pGet)('SELECT * FROM data_source WHERE id=?', [dsId]));
    const base = { appId, settings: (0, context_1.defaultSettings)(), app };
    const dev = { ...base, role: 'DEVELOPER', clientKey: 'dev-1' };
    const cli = { ...base, role: 'CLIENT', clientKey: 'cli-1' };
    console.log('=== M3 标签树（REQ-TAG-01/03/07）===');
    const devRoot = (await (0, tagTree_1.getRoot)(appId, 'DEVELOPER'));
    const cliRoot = (await (0, tagTree_1.getRoot)(appId, 'CLIENT'));
    const devBin = (await (0, tagTree_1.getRecycleBin)(appId, 'DEVELOPER'));
    ok(!!devRoot && !!cliRoot && !!devBin, '初始化出两棵树 + 回收站');
    ok((await (0, tagTree_1.listNodes)(appId, 'CLIENT')).length === 2, 'CLIENT 树初始 2 个系统节点');
    // 深度限制：ROOT(1) → d1(2) → d2(3) → d3(4) → d4(5)，第 6 层应拒
    let p = devRoot.id;
    const dirs = [];
    for (let i = 0; i < 4; i++) {
        p = await (0, tagTree_1.createNode)(appId, 'DEVELOPER', `目录${i + 1}`, p);
        dirs.push(p);
    }
    ok(dirs.length === 4, '连续建 4 层子目录成功');
    await expectCode(() => (0, tagTree_1.createNode)(appId, 'DEVELOPER', '超深目录', dirs[3]), 'MAX_DEPTH_EXCEEDED', '第 6 层目录被拒（MAX_DEPTH=5）');
    await expectCode(() => (0, tagTree_1.createNode)(appId, 'DEVELOPER', '回收站下', devBin.id), 'CANNOT_ADD_UNDER_BIN', '回收站下建目录被拒');
    await expectCode(() => (0, tagTree_1.renameNode)(appId, 'DEVELOPER', devRoot.id, '改名'), 'SYSTEM_NODE_IMMUTABLE', '重命名系统节点被拒');
    await (0, tagTree_1.renameNode)(appId, 'DEVELOPER', dirs[0], '目录一改名');
    ok((await (0, platform_1.pGet)('SELECT name FROM tag_node WHERE id=?', [dirs[0]])).name === '目录一改名', '普通目录可重命名');
    console.log('\n=== M3 双轨生命周期（REQ-SAVE-02 / REQ-LIFE-02/04/06/07/16）===');
    // 保存时先过网关前两道闸：非法 SQL 当场拒，不入库
    await expectCode(() => (0, report_1.saveReport)(dev, { name: '非法', sqlText: 'DROP TABLE orders', dataSourceId: ds.id }), 'STMT_NOT_READONLY', '保存 DROP 被拒（不入库）');
    await expectCode(() => (0, report_1.saveReport)(dev, { name: '非法2', sqlText: 'SELECT SLEEP(5)', dataSourceId: ds.id }), 'DANGEROUS_FUNCTION', '保存 SLEEP 被拒（不入库）');
    const otherDs = await (0, platform_1.pGet)('SELECT id FROM data_source WHERE app_id=(SELECT id FROM application WHERE path_prefix=?) LIMIT 1', ['demo']);
    if (otherDs) {
        await expectCode(() => (0, report_1.saveReport)(dev, { name: '越权', sqlText: 'SELECT 1', dataSourceId: otherDs.id }), 'FORBIDDEN', '不能绑定别的应用的数据源');
    }
    const reportId = await (0, report_1.saveReport)(dev, {
        name: `验证报表-${suffix}`,
        sqlText: 'SELECT region, COUNT(*) AS cnt FROM orders GROUP BY region',
        dataSourceId: ds.id,
        parentNodeId: dirs[1],
    });
    const pls = await (0, platform_1.pQuery)('SELECT * FROM report_placement WHERE report_id=?', [reportId]);
    ok(pls.length === 2, '保存即两棵树各一条 placement', `role=${pls.map((x) => x.role).join('/')}`);
    const cliPl = pls.find((x) => x.role === 'CLIENT');
    const devPl = pls.find((x) => x.role === 'DEVELOPER');
    ok(devPl.tag_node_id === dirs[1], '开发者侧落在指定目录');
    ok(cliPl.tag_node_id === cliRoot.id, '甲方侧落在甲方根目录');
    // 甲方删除 → 仅甲方进入回收站，开发者仍 NORMAL
    await (0, lifecycle_1.deleteReport)(cli, reportId);
    let r = (await (0, platform_1.pGet)('SELECT * FROM report WHERE id=?', [reportId]));
    ok(r.client_state === 'RECYCLED' && r.developer_state === 'NORMAL', '甲方删除：client=RECYCLED，developer=NORMAL（双轨独立）');
    ok((await (0, platform_1.pQuery)('SELECT 1 FROM report_placement WHERE report_id=? AND role=? AND tag_node_id=?', [reportId, 'CLIENT', cliRoot.id])).length === 0, '甲方侧已移出原目录');
    const cliBin0 = (await (0, tagTree_1.getRecycleBin)(appId, 'CLIENT'));
    const cliPlBin = (await (0, platform_1.pGet)('SELECT * FROM report_placement WHERE report_id=? AND role=?', [reportId, 'CLIENT']));
    ok(cliPlBin.tag_node_id === cliBin0.id, '甲方侧落入甲方回收站节点（回收站内容必须可列出）');
    ok((await (0, report_1.listReports)(dev)).some((x) => x.id === reportId), '开发者列表仍可见该报表');
    ok((await (0, report_1.listReports)(cli)).some((x) => x.id === reportId && x.tag_node_id === cliBin0.id), '甲方仍可见，但挂在回收站下');
    // 甲方还原 → 回到原父目录
    await (0, lifecycle_1.restoreReport)(cli, reportId);
    r = (await (0, platform_1.pGet)('SELECT * FROM report WHERE id=?', [reportId]));
    const cliPl2 = (await (0, platform_1.pGet)('SELECT * FROM report_placement WHERE report_id=? AND role=?', [reportId, 'CLIENT']));
    ok(r.client_state === 'NORMAL', '甲方还原后 client_state=NORMAL');
    ok(cliPl2.tag_node_id === cliRoot.id, '还原回原父目录（origin_parent_id 生效）');
    // 甲方清空 → client=PURGED，开发者仍可见（REQ-LIFE-07）
    await (0, lifecycle_1.purge)(cli, [reportId]);
    r = (await (0, platform_1.pGet)('SELECT * FROM report WHERE id=?', [reportId]));
    ok(r.client_state === 'PURGED', '甲方清空：client_state=PURGED');
    ok((await (0, report_1.listReports)(dev)).some((x) => x.id === reportId), '开发者仍可见（甲方清空不物理删除）');
    ok(!(await (0, report_1.listReports)(cli)).some((x) => x.id === reportId), '甲方不可见');
    // 开发者恢复甲方可见 → 落入甲方回收站（REQ-LIFE-16）
    await (0, lifecycle_1.restoreClientVisibility)(dev, reportId);
    r = (await (0, platform_1.pGet)('SELECT * FROM report WHERE id=?', [reportId]));
    const cliBin = (await (0, tagTree_1.getRecycleBin)(appId, 'CLIENT'));
    const cliPl3 = (await (0, platform_1.pGet)('SELECT * FROM report_placement WHERE report_id=? AND role=?', [reportId, 'CLIENT']));
    ok(r.client_state === 'RECYCLED', '恢复甲方可见：client_state=RECYCLED');
    ok(cliPl3.tag_node_id === cliBin.id, '落入甲方回收站');
    // 重复清空幂等 + 非回收站还原被拒
    await expectCode(() => (0, lifecycle_1.restoreReport)(dev, reportId), 'NOT_IN_RECYCLE_BIN', '开发者侧不在回收站 → 还原被拒');
    // 开发者清空（宽限 0 天）→ 物理删除，子表全部级联
    const dev0 = { ...dev, settings: { ...dev.settings, purgeGraceDays: 0 } };
    await (0, lifecycle_1.purge)(dev0, [reportId]);
    ok(!(await (0, platform_1.pGet)('SELECT id FROM report WHERE id=?', [reportId])), '开发者清空（grace=0）：report 行已物理删除');
    const leftover = await (0, platform_1.pQuery)(`SELECT 'placement' t, COUNT(*) c FROM report_placement WHERE report_id=?
     UNION ALL SELECT 'sql_version', COUNT(*) FROM sql_version WHERE report_id=?
     UNION ALL SELECT 'requirement', COUNT(*) FROM requirement WHERE report_id=?`, [reportId, reportId, reportId]);
    ok(leftover.every((x) => Number(x.c) === 0), 'placement/sql_version/requirement 全部级联删除', JSON.stringify(leftover.map((x) => `${x.t}=${x.c}`)));
    console.log('\n=== M4 协作需求（REQ-COL-01/04/05/07）===');
    const rep2 = await (0, report_1.saveReport)(dev, { name: `协作报表-${suffix}`, sqlText: 'SELECT * FROM orders LIMIT 10', dataSourceId: ds.id });
    const cliOnly = { ...cli, clientKey: 'cli-A' };
    const reqId = await (0, requirement_1.createRequirement)(cliOnly, { prompt: '想看华东的订单明细', reportId: rep2 });
    ok((await (0, requirement_1.listInbox)(dev)).some((x) => x.id === reqId), '开发者收件箱可见甲方需求');
    const mineA = await (0, requirement_1.listMine)(cliOnly);
    ok(mineA.some((x) => x.id === reqId), '甲方只见自己提交的需求');
    const cliB = { ...cli, clientKey: 'cli-B' };
    ok(!(await (0, requirement_1.listMine)(cliB)).some((x) => x.id === reqId), '另一位甲方看不到（client_key 隔离）');
    await (0, requirement_1.completeRequirement)(dev, reqId);
    ok((await (0, platform_1.pGet)('SELECT status FROM requirement WHERE id=?', [reqId])).status === 'PENDING_CONFIRM', '开发者完成 → PENDING_CONFIRM');
    await expectCode(() => (0, requirement_1.confirmRequirement)(dev, reqId, true), 'FORBIDDEN', '开发者不能代替甲方确认');
    await (0, requirement_1.confirmRequirement)(cliOnly, reqId, true);
    ok((await (0, platform_1.pGet)('SELECT status FROM requirement WHERE id=?', [reqId])).status === 'CONFIRMED', '甲方确认 → CONFIRMED');
    console.log('\n=== M5 审计（REQ-AUD-01）===');
    const audits = await (0, platform_1.pQuery)('SELECT action, COUNT(*) c FROM audit_log WHERE app_id=? GROUP BY action ORDER BY action', [appId]);
    ok(audits.length > 0, '审计日志已落库', audits.map((a) => `${a.action}×${a.c}`).join(' '));
    console.log('\n=== M6 应用管理（REQ-ACC-10/13）===');
    const rootApp = (await (0, platform_1.pGet)('SELECT * FROM application WHERE is_platform_root=1'));
    const rootCtx = { appId: rootApp.id, role: 'DEVELOPER', clientKey: 'root', settings: (0, context_1.defaultSettings)(), app: rootApp };
    await expectCode(() => (0, application_1.disableApplication)(dev, rootApp.id), 'NOT_PLATFORM_ROOT', '非平台根应用不能停用别的应用');
    await expectCode(() => (0, application_1.disableApplication)(rootCtx, rootApp.id), 'CANNOT_DISABLE_ROOT', '平台根应用自身不可停用');
    await (0, application_1.disableApplication)(rootCtx, appId);
    ok((await (0, platform_1.pGet)('SELECT status FROM application WHERE id=?', [appId])).status === 'DISABLED', '平台根可停用普通应用');
    // 清理本轮临时数据（审计/需求/节点/数据源/报表/应用）
    await (0, platform_1.pRun)('DELETE FROM audit_log WHERE app_id=?', [appId]);
    await (0, platform_1.pRun)('DELETE FROM requirement WHERE app_id=?', [appId]);
    await (0, platform_1.pRun)('DELETE FROM report_placement WHERE report_id IN (SELECT id FROM report WHERE app_id=?)', [appId]);
    await (0, platform_1.pRun)('DELETE FROM sql_version WHERE app_id=?', [appId]);
    await (0, platform_1.pRun)('DELETE FROM report WHERE app_id=?', [appId]);
    await (0, platform_1.pRun)('DELETE FROM tag_node WHERE app_id=?', [appId]);
    await (0, platform_1.pRun)('DELETE FROM data_source WHERE app_id=?', [appId]);
    await (0, platform_1.pRun)('DELETE FROM application WHERE id=?', [appId]);
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
    process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('VERIFY-LIFECYCLE ERROR:', e); process.exit(1); });
