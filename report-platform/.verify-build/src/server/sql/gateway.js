"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateOnly = validateOnly;
exports.execute = execute;
// ★ 全项目唯一 SQL 执行入口（doc §1.1、§6.4、REQ-SEC-08、REQ-PARAM-07、ADR-13）。
// 五道闸：Parse → Validate → Rewrite → Execute → Shape。
const parser_1 = require("./parser");
const validator_1 = require("./validator");
const rewriter_1 = require("./rewriter");
const executor_1 = require("./executor");
const shape_1 = require("./shape");
const audit_1 = require("../services/audit");
const errors_1 = require("../errors");
// 只走前两道闸（Parse → Validate），不执行、不连业务库、不写运行审计。
// 用途：保存报表 / 更新 SQL 时前置校验，避免把非法 SQL 存进去，等甲方点开才报错（快速失败）。
function validateOnly(rawSql, databaseName) {
    const { paramNames, ast } = (0, parser_1.parse)(rawSql);
    (0, validator_1.validate)(ast, rawSql, [databaseName]);
    return { paramNames };
}
async function execute(ds, rawSql, params, opt) {
    const started = Date.now();
    const sensitive = (0, shape_1.parseSensitive)(ds.sensitive_columns_json);
    try {
        const { template, paramNames, ast } = (0, parser_1.parse)(rawSql);
        (0, validator_1.validate)(ast, rawSql, [ds.database_name]);
        const finalSql = (0, rewriter_1.rewrite)(ast, opt.maxRows);
        const values = (0, parser_1.bindValues)(paramNames, params);
        // fields 一并取回：0 行时也能给出表头，否则前端看到的是完全空白，
        // 用户分不清「查到 0 行」和「查询坏了」。
        const { rows, fields } = await (0, executor_1.withReadonlyConn)(ds, opt.timeoutMs, async (conn) => {
            const [r, f] = await conn.execute(finalSql, values); // 真 prepared statement
            return { rows: r, fields: (f ?? []) };
        });
        const shaped = (0, shape_1.applyShape)(rows, sensitive);
        const columns = shaped[0] ? Object.keys(shaped[0]) : fields.map((f) => f.name);
        await (0, audit_1.auditRun)(opt.ctx, {
            sql: finalSql,
            params,
            rows: rows.length,
            ms: Date.now() - started,
            result: 'SUCCESS',
            source: opt.source,
            reportId: opt.reportId,
            dataSourceId: ds.id,
        });
        return {
            columns,
            rows: shaped,
            truncated: false,
        };
    }
    catch (e) {
        const rejected = e instanceof Error && e.name === 'SqlReject';
        // 表不存在/列名写错/无权限/超时 → 翻译成明确编号，走 400（用户可自行修正）
        const dbErr = (0, errors_1.mapDbError)(e);
        const finalErr = dbErr ?? e;
        await (0, audit_1.auditRun)(opt.ctx, {
            sql: rawSql,
            params,
            rows: 0,
            ms: Date.now() - started,
            result: rejected || dbErr ? 'REJECTED' : 'FAILED',
            source: opt.source,
            errorCode: finalErr?.code,
            reportId: opt.reportId,
            dataSourceId: ds.id,
        });
        throw finalErr;
    }
}
