"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRequirement = createRequirement;
exports.listInbox = listInbox;
exports.listMine = listMine;
exports.listForReport = listForReport;
exports.completeRequirement = completeRequirement;
exports.confirmRequirement = confirmRequirement;
// 协作需求服务（doc §10.5、REQ-COL-01~08）。需求状态机 OPEN→IN_PROGRESS→PENDING_CONFIRM→CONFIRMED。
const platform_1 = require("../db/platform");
const errors_1 = require("../errors");
const node_crypto_1 = __importDefault(require("node:crypto"));
// 甲方求助开发者（REQ-COL-01）
async function createRequirement(ctx, input) {
    const id = node_crypto_1.default.randomUUID();
    await (0, platform_1.pRun)(`INSERT INTO requirement (id,app_id,report_id,status,prompt,failed_sql,error_msg,client_note,client_key,created_by_role)
     VALUES (?,?,?,?,?,?,?,?,?,?)`, [id, ctx.appId, input.reportId ?? null, 'OPEN', input.prompt ?? null, input.failedSql ?? null, input.errorMsg ?? null, input.clientNote ?? null, ctx.clientKey, ctx.role]);
    return id;
}
// 开发者收件箱：看全部（REQ-COL-07）
async function listInbox(ctx) {
    if (ctx.role !== 'DEVELOPER')
        throw new errors_1.HttpError(403, 'FORBIDDEN');
    return (0, platform_1.pQuery)('SELECT * FROM requirement WHERE app_id=? ORDER BY created_at DESC', [ctx.appId]);
}
// 甲方只见自己提交的（REQ-META-02/03）
async function listMine(ctx) {
    return (0, platform_1.pQuery)('SELECT * FROM requirement WHERE app_id=? AND client_key=? ORDER BY created_at DESC', [ctx.appId, ctx.clientKey]);
}
async function listForReport(ctx, reportId) {
    if (ctx.role === 'CLIENT') {
        return (0, platform_1.pQuery)('SELECT * FROM requirement WHERE app_id=? AND report_id=? AND client_key=? ORDER BY created_at DESC', [ctx.appId, reportId, ctx.clientKey]);
    }
    return (0, platform_1.pQuery)('SELECT * FROM requirement WHERE app_id=? AND report_id=? ORDER BY created_at DESC', [ctx.appId, reportId]);
}
// 开发者开始处理（REQ-COL-04）→ PENDING_CONFIRM
async function completeRequirement(ctx, id) {
    if (ctx.role !== 'DEVELOPER')
        throw new errors_1.HttpError(403, 'FORBIDDEN');
    await (0, platform_1.platformTx)(async (tx) => {
        const r = await tx.get('SELECT * FROM requirement WHERE id=? AND app_id=?', [id, ctx.appId]);
        if (!r)
            throw new errors_1.HttpError(404, 'REQ_NOT_FOUND');
        await tx.run("UPDATE requirement SET status='PENDING_CONFIRM', updated_at=NOW() WHERE id=?", [id]);
    });
}
// 甲方确认/驳回（REQ-COL-05/06）
async function confirmRequirement(ctx, id, confirm) {
    if (ctx.role !== 'CLIENT')
        throw new errors_1.HttpError(403, 'FORBIDDEN');
    await (0, platform_1.platformTx)(async (tx) => {
        const r = await tx.get('SELECT * FROM requirement WHERE id=? AND app_id=? AND client_key=?', [id, ctx.appId, ctx.clientKey]);
        if (!r)
            throw new errors_1.HttpError(404, 'REQ_NOT_FOUND');
        await tx.run('UPDATE requirement SET status=?, updated_at=NOW() WHERE id=?', [confirm ? 'CONFIRMED' : 'OPEN', id]);
    });
}
