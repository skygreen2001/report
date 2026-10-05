"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadReportForRole = loadReportForRole;
exports.listReports = listReports;
exports.saveReport = saveReport;
exports.updateSql = updateSql;
exports.getSqlVersions = getSqlVersions;
// 报表服务（doc §5、§9、REQ-SAVE/REQ-LIFE）。双轨可见性 + 保存即两棵树同时出现（M3 验收）。
const platform_1 = require("../db/platform");
const tagTree_1 = require("./tagTree");
const audit_1 = require("./audit");
const gateway_1 = require("../sql/gateway");
const datasource_1 = require("./datasource");
const errors_1 = require("../errors");
const node_crypto_1 = __importDefault(require("node:crypto"));
// 本角色可见的报表（按双轨状态过滤，REQ-LIFE-07/12）
async function loadReportForRole(ctx, id) {
    const stateCol = ctx.role === 'DEVELOPER' ? 'developer_state' : 'client_state';
    const r = await (0, platform_1.pGet)(`SELECT * FROM report WHERE id=? AND app_id=? AND ${stateCol} != 'PURGED'`, [id, ctx.appId]);
    if (!r)
        throw new errors_1.HttpError(404, 'REPORT_NOT_FOUND');
    return r;
}
async function listReports(ctx) {
    const stateCol = ctx.role === 'DEVELOPER' ? 'developer_state' : 'client_state';
    return (0, platform_1.pQuery)(`SELECT r.id, r.name, r.data_source_id, rp.tag_node_id,
            r.client_state, r.developer_state, r.created_at
     FROM report r
     LEFT JOIN report_placement rp ON rp.report_id=r.id AND rp.role=?
     WHERE r.app_id=? AND r.${stateCol} != 'PURGED'
     ORDER BY r.created_at DESC`, [ctx.role, ctx.appId]);
}
// 保存为常用报表：同一事务内为两棵树各建一条 placement（REQ-SAVE-02、M3 验收）
async function saveReport(ctx, input) {
    // 保存前先过网关前两道闸：非法 SQL（写操作/系统库/危险函数/多语句）当场拒，不入库
    const ds = await (0, datasource_1.loadDataSource)(input.dataSourceId);
    if (ds.app_id !== ctx.appId)
        throw new errors_1.HttpError(403, 'FORBIDDEN');
    (0, gateway_1.validateOnly)(input.sqlText, ds.database_name);
    const id = node_crypto_1.default.randomUUID();
    await (0, platform_1.platformTx)(async (tx) => {
        await tx.run(`INSERT INTO report (id,app_id,name,sql_text,data_source_id,params_schema_json,created_by,client_state,developer_state)
       VALUES (?,?,?,?,?,?,?,?,?)`, [id, ctx.appId, input.name, input.sqlText, input.dataSourceId, input.paramsSchemaJson ?? null, ctx.clientKey, 'NORMAL', 'NORMAL']);
        // 当前角色落指定目录（或根），另一角色落其根（两份 placement 同时出现，REQ-SAVE-02）
        const myRoot = await (0, tagTree_1.getRoot)(ctx.appId, ctx.role);
        const otherRole = ctx.role === 'DEVELOPER' ? 'CLIENT' : 'DEVELOPER';
        const otherRoot = await (0, tagTree_1.getRoot)(ctx.appId, otherRole);
        const myParent = input.parentNodeId ?? myRoot.id;
        await tx.run('INSERT INTO report_placement (report_id,role,tag_node_id,origin_parent_id) VALUES (?,?,?,?)', [id, ctx.role, myParent, myParent]);
        await tx.run('INSERT INTO report_placement (report_id,role,tag_node_id,origin_parent_id) VALUES (?,?,?,?)', [id, otherRole, otherRoot.id, otherRoot.id]);
        // 首个 SQL 版本（追加不可变，REQ-META-05）
        await tx.run('INSERT INTO sql_version (id,report_id,app_id,sql_text,note,created_by_role) VALUES (?,?,?,?,\'初始版本\',?)', [node_crypto_1.default.randomUUID(), id, ctx.appId, input.sqlText, ctx.role]);
        await tx.run('UPDATE report SET current_sql_version_id=(SELECT id FROM sql_version WHERE report_id=? ORDER BY created_at DESC LIMIT 1) WHERE id=?', [id, id]);
    });
    await (0, audit_1.auditAction)(ctx, { action: 'SAVE_REPORT', targetType: 'report', targetId: id });
    return id;
}
async function updateSql(ctx, id, sqlText, note) {
    if (ctx.role !== 'DEVELOPER')
        throw new errors_1.HttpError(403, 'FORBIDDEN'); // 仅开发者改 SQL
    await (0, platform_1.platformTx)(async (tx) => {
        const r = await tx.get('SELECT * FROM report WHERE id=? AND app_id=?', [id, ctx.appId]);
        if (!r)
            throw new errors_1.HttpError(404, 'REPORT_NOT_FOUND');
        // 改 SQL 同样先过前两道闸（REQ-SEC-01）
        const ds = await (0, datasource_1.loadDataSource)(r.data_source_id);
        (0, gateway_1.validateOnly)(sqlText, ds.database_name);
        await tx.run('INSERT INTO sql_version (id,report_id,app_id,sql_text,note,created_by_role) VALUES (?,?,?,?,?,?)', [node_crypto_1.default.randomUUID(), id, ctx.appId, sqlText, note ?? '', 'DEVELOPER']);
        const vid = (await tx.query('SELECT id FROM sql_version WHERE report_id=? ORDER BY created_at DESC LIMIT 1', [id]))[0].id;
        await tx.run('UPDATE report SET sql_text=?, current_sql_version_id=? WHERE id=?', [sqlText, vid, id]);
    });
    await (0, audit_1.auditAction)(ctx, { action: 'UPDATE_SQL', targetType: 'report', targetId: id });
}
async function getSqlVersions(ctx, id) {
    if (ctx.role !== 'DEVELOPER')
        throw new errors_1.HttpError(403, 'FORBIDDEN');
    return (0, platform_1.pQuery)('SELECT id,sql_text,note,created_by_role,created_at FROM sql_version WHERE report_id=? ORDER BY created_at DESC', [id]);
}
