"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parse = parse;
exports.bindValues = bindValues;
// ① 解析：AST 解析 + 占位符 {{name}} → ?（doc §6.1）。node-sql-parser v5 实测见 §15.1。
const node_sql_parser_1 = require("node-sql-parser");
const errors_1 = require("../errors");
const parser = new node_sql_parser_1.Parser();
// 占位符：{{ name }}，只出现在值位置
const PH = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
// 值位置判定：前后只能是空白、逗号、括号、比较/算术运算符（注意 / 需转义，否则会截断正则）
const PREV_OK = /^[\s,(=<>!+\-*\/%]$/;
const NEXT_OK = /^[\s,)=<>!+\-*\/%]$/;
function parse(sql) {
    // 归一化：仅剥离尾部空白与分号（LLM 输出 / 用户粘贴常见 "SELECT ...;"）。
    // 注意只处理尾部——语句内部的分号仍会被 astify 解析成数组，按 MULTI_STATEMENT 拒绝（REQ-SEC-02）。
    const src = sql.replace(/[\s;]+$/, '');
    if (!src)
        throw new errors_1.SqlReject('PARSE_FAILED', 'SQL 为空');
    const paramNames = [];
    const template = src.replace(PH, (m, name, offset) => {
        const prev = src[offset - 1] ?? ' ';
        const next = src[offset + m.length] ?? ' ';
        // 占位符只能出现在值位置（REQ-PARAM-01）；FROM {{table}} 这种会被 astify 语法错误兜底（§15.3）
        if (!PREV_OK.test(prev) || !NEXT_OK.test(next)) {
            throw new errors_1.SqlReject('PARAM_NOT_IN_VALUE_POSITION', `参数 ${name} 只能出现在值位置`);
        }
        paramNames.push(name);
        return '?';
    });
    let ast;
    try {
        ast = parser.astify(template, { database: 'MySQL' });
    }
    catch {
        throw new errors_1.SqlReject('PARSE_FAILED', 'SQL 无法解析');
    }
    // 多语句 → 拒绝（REQ-SEC-02）。astify 多语句返回数组。
    if (Array.isArray(ast))
        throw new errors_1.SqlReject('MULTI_STATEMENT', '不允许一次执行多条语句');
    return { template, paramNames, ast };
}
// 按 paramNames 顺序把 name → value 排成数组（重复出现需重复给值）
function bindValues(paramNames, input) {
    return paramNames.map((n) => {
        if (!(n in input))
            throw new errors_1.SqlReject('PARAM_MISSING', `缺少参数 ${n}`);
        return input[n];
    });
}
