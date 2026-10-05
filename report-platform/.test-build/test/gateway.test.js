"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// SQL 安全网关对抗用例（doc §12.2）。运行：npm run test:gateway
// 直接 import 网关模块（框架无关，无需 Next 构建），覆盖 19 条用例。
const parser_1 = require("../src/server/sql/parser");
const validator_1 = require("../src/server/sql/validator");
const rewriter_1 = require("../src/server/sql/rewriter");
const errors_1 = require("../src/server/errors");
// 复刻 execute 的前三道闸用于测试（parse→validate→rewrite 注入 LIMIT）
async function gate(sql, maxRows = 200) {
    try {
        const { ast } = (0, parser_1.parse)(sql);
        (0, validator_1.validate)(ast, sql, ['biz_demo']);
        const finalSql = (0, rewriter_1.rewrite)(ast, maxRows);
        return { ok: true, finalSql };
    }
    catch (e) {
        if (e instanceof errors_1.SqlReject)
            return { ok: false, code: e.code };
        return { ok: false, code: e.name };
    }
}
let pass = 0, fail = 0;
function check(name, got, expect, extra = '') {
    if (got === expect) {
        pass++;
        console.log(`  ✓ ${name}`);
    }
    else {
        fail++;
        console.log(`  ✗ ${name}  期望=${expect} 实际=${got} ${extra}`);
    }
}
function checkReject(name, code, expectCode) {
    const ok = code === expectCode;
    if (ok) {
        pass++;
        console.log(`  ✓ ${name} → ${code}`);
    }
    else {
        fail++;
        console.log(`  ✗ ${name}  期望拒绝码=${expectCode} 实际=${code}`);
    }
}
async function main() {
    console.log('SQL 安全网关对抗用例（§12.2）');
    // 1. 正常参数化 SELECT → 通过
    let r = await gate('SELECT * FROM orders WHERE created_at > {{d}}');
    check('参数化SELECT通过', r.ok, true);
    check('参数名抽取正确', (() => { try {
        const p = (0, parser_1.parse)('SELECT * FROM orders WHERE created_at > {{d}}');
        return JSON.stringify(p.paramNames) === '["d"]';
    }
    catch {
        return false;
    } })(), true);
    // 2. 多语句堆叠 → MULTI_STATEMENT
    r = await gate('SELECT 1; DROP TABLE orders');
    checkReject('多语句堆叠', r.code, 'MULTI_STATEMENT');
    // 3. 可执行注释 → DEEP_SCAN_BLOCK
    r = await gate('SELECT 1 /*!50000 , (DROP TABLE t) */');
    checkReject('可执行注释', r.code, 'DEEP_SCAN_BLOCK');
    // 4. 字符串里的关键字 → 通过（不误报）
    r = await gate("SELECT 'DROP TABLE' AS a");
    check('字符串内关键字不误报', r.ok, true);
    // 5. CTE 后接写操作 → STMT_NOT_READONLY
    r = await gate('WITH c AS (SELECT 1) DELETE FROM t');
    checkReject('CTE+DELETE', r.code, 'STMT_NOT_READONLY');
    // 6. INTO OUTFILE → DEEP_SCAN_BLOCK / DML
    r = await gate("SELECT * FROM t INTO OUTFILE '/tmp/x'");
    checkReject('INTO OUTFILE', r.code, 'DEEP_SCAN_BLOCK');
    // 7. SLEEP → DANGEROUS_FUNCTION
    r = await gate('SELECT SLEEP(10)');
    checkReject('SLEEP', r.code, 'DANGEROUS_FUNCTION');
    // 8. 系统库 → SYSTEM_SCHEMA
    r = await gate('SELECT * FROM mysql.user');
    checkReject('系统库 mysql.user', r.code, 'SYSTEM_SCHEMA');
    // 9. 跨库越权 → SCHEMA_NOT_ALLOWED
    r = await gate('SELECT * FROM other_db.t');
    checkReject('跨库 other_db.t', r.code, 'SCHEMA_NOT_ALLOWED');
    // 10. 大小写无关 → 通过
    r = await gate('sElEcT * FROM orders');
    check('大小写无关', r.ok, true);
    // 11. 自带超大 LIMIT → 通过且被截断
    r = await gate('SELECT * FROM t LIMIT 999999999');
    check('超大LIMIT被截断', r.ok && (r.finalSql?.toUpperCase().includes('LIMIT 200') || /LIMIT\s+200\b/i.test(r.finalSql || '')), true, r.finalSql || '');
    // 12. 笛卡尔积 → 通过但注入 LIMIT
    r = await gate('SELECT * FROM a, b');
    check('笛卡尔积注入LIMIT', r.ok && /LIMIT/i.test(r.finalSql || ''), true);
    // 13. 占位符当表名 → 拒绝（PARAM_NOT_IN_VALUE_POSITION 或 PARSE_FAILED）
    r = await gate('SELECT * FROM {{table}}');
    check('占位符当表名拒绝', !r.ok, true, r.code || '');
    // 14. UNION 链尾 LIMIT（不能出现 LIMIT...UNION）
    r = await gate('SELECT a FROM t UNION SELECT b FROM x');
    check('UNION LIMIT挂链尾', r.ok && !/LIMIT[\s\S]*UNION/i.test(r.finalSql || ''), true, r.finalSql || '');
    // 15. 复杂 SQL：要么正确改写要么 REWRITE_FAILED（不出现第三种）
    const complex = 'SELECT region, SUM(amount) AS amt FROM orders WHERE created_at > {{d}} GROUP BY region HAVING SUM(amount) > 100 ORDER BY amt DESC LIMIT 50';
    r = await gate(complex, 200);
    check('复杂SQL改写或拒绝(二选一)', r.ok || r.code === 'REWRITE_FAILED', true, r.ok ? r.finalSql : r.code);
    // 16. 占位符非值位置（FROM 后）→ 拒绝
    r = await gate('SELECT * FROM orders WHERE region = {{r}}');
    check('参数化等值查询通过', r.ok, true);
    // 17. 注释截断绕过 → 通过（正常SQL带注释不误杀）
    r = await gate('SELECT 1 -- this is fine');
    check('行注释正常SQL通过', r.ok, true);
    // 18. 字符串内含分号 → 不误判多语句（解析为单条）
    r = await gate("SELECT 'a;b' AS x");
    check('字符串内分号不误判', r.ok, true);
    // 19. SET 会话篡改 → STMT_NOT_READONLY
    r = await gate('SET SESSION max_execution_time=0');
    checkReject('SET会话篡改', r.code, 'STMT_NOT_READONLY');
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
    if (fail > 0)
        process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
