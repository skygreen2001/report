"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteReport = deleteReport;
exports.restoreReport = restoreReport;
exports.purge = purge;
exports.restoreClientVisibility = restoreClientVisibility;
// 双轨生命周期服务（doc §7、REQ-LIFE-01~16）。两轨独立，唯一交汇点是开发者清空=物理删除。
const fs_1 = __importDefault(require("fs"));
const platform_1 = require("../db/platform");
const tagTree_1 = require("./tagTree");
const audit_1 = require("./audit");
const errors_1 = require("../errors");
const STATE_COL = { client: 'client_state', developer: 'developer_state' };
async function deleteReport(ctx, reportId) {
    const track = ctx.role === 'DEVELOPER' ? 'developer' : 'client';
    await (0, platform_1.platformTx)(async (tx) => {
        const r = await tx.get('SELECT * FROM report WHERE id=? AND app_id=? FOR UPDATE', [reportId, ctx.appId]);
        if (!r)
            throw new errors_1.HttpError(404, 'REPORT_NOT_FOUND');
        if (r[STATE_COL[track]] !== 'NORMAL')
            return; // 幂等（REQ-LIFE-02/09）
        const bin = await (0, tagTree_1.getRecycleBin)(ctx.appId, ctx.role);
        const pl = await tx.get('SELECT * FROM report_placement WHERE report_id=? AND role=?', [reportId, ctx.role]);
        await tx.run(`UPDATE report SET ${STATE_COL[track]}='RECYCLED', ${track}_recycled_at=NOW() WHERE id=?`, [reportId]);
        await tx.run('UPDATE report_placement SET tag_node_id=?, origin_parent_id=?, recycled_at=NOW() WHERE report_id=? AND role=?', [bin.id, pl?.tag_node_id ?? null, reportId, ctx.role]);
        await (0, audit_1.auditAction)(ctx, { action: 'DELETE', targetType: 'report', targetId: reportId });
    });
}
async function restoreReport(ctx, reportId) {
    const track = ctx.role === 'DEVELOPER' ? 'developer' : 'client';
    await (0, platform_1.platformTx)(async (tx) => {
        const r = await tx.get('SELECT * FROM report WHERE id=? AND app_id=? FOR UPDATE', [reportId, ctx.appId]);
        if (!r)
            throw new errors_1.HttpError(404, 'REPORT_NOT_FOUND');
        if (r[STATE_COL[track]] !== 'RECYCLED')
            throw new errors_1.HttpError(409, 'NOT_IN_RECYCLE_BIN');
        // origin_parent_id 记在 report_placement 上（不是 report 上）——取错表会静默回落根目录
        const pl = await tx.get('SELECT origin_parent_id FROM report_placement WHERE report_id=? AND role=?', [reportId, ctx.role]);
        let target = pl?.origin_parent_id ?? null;
        if (target && !(await nodeExists(tx, target, ctx.role))) {
            target = (await (0, tagTree_1.getRoot)(ctx.appId, ctx.role)).id; // 原父已删 → 落根（REQ-LIFE-04/05）
        }
        await tx.run(`UPDATE report SET ${STATE_COL[track]}='NORMAL' WHERE id=?`, [reportId]);
        await tx.run('UPDATE report_placement SET tag_node_id=?, origin_parent_id=NULL, recycled_at=NULL WHERE report_id=? AND role=?', [target, reportId, ctx.role]);
        await (0, audit_1.auditAction)(ctx, { action: 'RESTORE', targetType: 'report', targetId: reportId });
    });
}
async function purge(ctx, ids) {
    const track = ctx.role === 'DEVELOPER' ? 'developer' : 'client';
    await (0, platform_1.platformTx)(async (tx) => {
        for (const id of ids) {
            const r = await tx.get('SELECT * FROM report WHERE id=? AND app_id=? FOR UPDATE', [id, ctx.appId]);
            if (!r)
                continue;
            if (track === 'developer') {
                const grace = ctx.settings.purgeGraceDays; // 默认 7，可配 0~30（REQ-LIFE-10/15）
                if (grace > 0) {
                    await tx.run(`UPDATE report SET developer_state='PURGED', purge_due_at=DATE_ADD(NOW(), INTERVAL ? DAY) WHERE id=?`, [grace, id]);
                }
                else {
                    await hardDelete(tx, ctx, id);
                }
            }
            else {
                // 甲方清空 = 仅甲方不可见，开发者仍可见（REQ-LIFE-06/07/08）
                await tx.run("UPDATE report SET client_state='PURGED', client_purged_at=NOW() WHERE id=?", [id]);
            }
            await (0, audit_1.auditAction)(ctx, { action: 'PURGE', targetType: 'report', targetId: id });
        }
    });
}
// 开发者恢复甲方可见：甲方 PURGED → 落入甲方回收站（REQ-LIFE-16、Q-05）
async function restoreClientVisibility(ctx, reportId) {
    if (ctx.role !== 'DEVELOPER')
        throw new errors_1.HttpError(403, 'FORBIDDEN');
    await (0, platform_1.platformTx)(async (tx) => {
        const r = await tx.get('SELECT * FROM report WHERE id=? AND app_id=? FOR UPDATE', [reportId, ctx.appId]);
        if (!r)
            throw new errors_1.HttpError(404, 'REPORT_NOT_FOUND');
        if (r.client_state !== 'PURGED')
            throw new errors_1.HttpError(409, 'CLIENT_NOT_PURGED');
        const bin = await (0, tagTree_1.getRecycleBin)(ctx.appId, 'CLIENT');
        await tx.run("UPDATE report SET client_state='RECYCLED', client_recycled_at=NOW() WHERE id=?", [reportId]);
        await tx.run('UPDATE report_placement SET tag_node_id=?, recycled_at=NOW() WHERE report_id=? AND role=?', [bin.id, reportId, 'CLIENT']);
    });
}
// 物理删除：级联顺序子表→父表（REQ-LIFE-10/14）
async function hardDelete(tx, ctx, id) {
    // ① 先取导出文件清单再删行，否则 DELETE 之后就查不到 file_key 了（REQ-LIFE-10）
    const files = (await tx.query('SELECT file_key FROM export_task WHERE report_id=?', [id]));
    await tx.run('UPDATE report SET current_sql_version_id=NULL WHERE id=?', [id]);
    await tx.run('DELETE FROM report_placement WHERE report_id=?', [id]);
    await tx.run('DELETE FROM requirement WHERE report_id=?', [id]);
    await tx.run('DELETE FROM sql_version WHERE report_id=?', [id]);
    await tx.run('DELETE FROM export_task WHERE report_id=?', [id]);
    await tx.run('DELETE FROM run_record WHERE report_id=?', [id]);
    await tx.run('DELETE FROM report WHERE id=? AND app_id=?', [id, ctx.appId]);
    // ② 事务提交后再删磁盘文件，失败不影响数据一致性
    for (const f of files) {
        if (f.file_key) {
            try {
                fs_1.default.rmSync(f.file_key, { force: true });
            }
            catch {
                /* noop */
            }
        }
    }
}
async function nodeExists(tx, nodeId, role) {
    const n = await tx.get('SELECT id FROM tag_node WHERE id=? AND role=?', [nodeId, role]);
    return !!n;
}
