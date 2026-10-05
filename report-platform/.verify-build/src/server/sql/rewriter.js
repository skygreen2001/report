"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rewrite = rewrite;
exports.rewriteBase = rewriteBase;
// ③ LIMIT 注入（doc §6.3 + §15.2 修正3：UNION 必须挂 _next 链尾）。
const node_sql_parser_1 = require("node-sql-parser");
const errors_1 = require("../errors");
const parser = new node_sql_parser_1.Parser();
function readCurrentLimit(n) {
    const v = n?.limit?.value?.[0]?.value ?? n?.limit?.selexpr?.value;
    return typeof v === 'number' && Number.isFinite(v) ? v : Infinity;
}
function setLimit(n, final) {
    n.limit = { seperator: '', offset: null, value: [{ type: 'number', value: final }] };
}
// 走到 UNION 链尾（ast._next），避免只对第一分支限流（§15.2 修正3）
function tailNode(ast) {
    let n = ast;
    while (n._next)
        n = n._next;
    return n;
}
// 预览/交互：注入 LIMIT = min(原值, maxRows)
function rewrite(ast, maxRows) {
    const tail = tailNode(ast);
    const cur = readCurrentLimit(tail);
    const final = Number.isFinite(cur) ? Math.min(cur, maxRows) : maxRows;
    setLimit(tail, final);
    try {
        const out = parser.sqlify(ast, { database: 'MySQL' });
        if (!out)
            throw new Error('empty');
        return out;
    }
    catch {
        // fail-closed：无法确信改写正确就拒绝，绝不带病执行
        throw new errors_1.SqlReject('REWRITE_FAILED', 'SQL 过于复杂，无法安全改写，请简化后重试');
    }
}
// 导出基线：移除 LIMIT，由分页层控制（doc §6.3 末尾注意）
function rewriteBase(ast) {
    const tail = tailNode(ast);
    tail.limit = undefined;
    try {
        const out = parser.sqlify(ast, { database: 'MySQL' });
        if (!out)
            throw new Error('empty');
        return out;
    }
    catch {
        throw new errors_1.SqlReject('REWRITE_FAILED', 'SQL 过于复杂，无法安全改写，请简化后重试');
    }
}
