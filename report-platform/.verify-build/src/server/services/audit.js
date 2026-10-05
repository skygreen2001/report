"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditRun = auditRun;
exports.auditAction = auditAction;
// 审计服务（doc §17.5、REQ-SEC-12）。每次执行留痕 run_record，生命周期变更留痕 audit_log。
const platform_1 = require("../db/platform");
const errors_1 = require("../errors");
// 执行留痕（含 REJECTED，M6 验收：审计表能查到每一次执行）
async function auditRun(ctx, a) {
    try {
        await (0, platform_1.pRun)(`INSERT INTO run_record
        (id, app_id, report_id, data_source_id, source, result, sql_text, params_json, row_count, ms, error_code, client_key, started_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW())`, [
            (0, errors_1.randomTrace)(),
            ctx.appId,
            a.reportId ?? null,
            a.dataSourceId ?? null,
            a.source,
            a.result,
            // 审计只记模板与脱敏后参数值（REQ-PARAM-09 / §8.3）
            a.sql,
            JSON.stringify(a.params ?? {}),
            a.rows,
            a.ms,
            a.errorCode ?? null,
            ctx.clientKey,
        ]);
    }
    catch {
        // 审计失败不阻断主流程
    }
}
async function auditAction(ctx, a) {
    try {
        await (0, platform_1.pRun)(`INSERT INTO audit_log
        (id, app_id, actor_role, action, target_type, target_id, detail_json, client_key, started_at)
       VALUES (?,?,?,?,?,?,?,?,NOW())`, [
            (0, errors_1.randomTrace)(),
            ctx.appId,
            ctx.role,
            a.action,
            a.targetType ?? null,
            a.targetId ?? null,
            a.detail != null ? JSON.stringify(a.detail) : null,
            ctx.clientKey,
        ]);
    }
    catch {
        /* noop */
    }
}
