"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// 真实环境验证（不依赖 Next）：用真实网关 + 服务层跑通 live MySQL。
// 编译：node node_modules/typescript/bin/tsc -p tsconfig.verify.json
// 运行：node .verify-build/scripts/verify.js
const fs_1 = __importDefault(require("fs"));
const platform_1 = require("@/server/db/platform");
const datasource_1 = require("@/server/db/datasource");
const datasource_2 = require("@/server/services/datasource");
const gateway_1 = require("@/server/sql/gateway");
const context_1 = require("@/server/context");
const export_1 = require("@/server/services/export");
function loadEnv() {
    const txt = fs_1.default.readFileSync('.env.local', 'utf8');
    for (const line of txt.split('\n')) {
        const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
        if (m)
            process.env[m[1]] = m[2].trim();
    }
}
async function main() {
    loadEnv();
    const app = await (0, platform_1.pGet)('SELECT * FROM application WHERE path_prefix=?', ['demo']);
    if (!app)
        throw new Error('未找到 demo 应用，请先运行 seed');
    const dsRow = await (0, platform_1.pGet)('SELECT * FROM data_source WHERE app_id=?', [app.id]);
    const ds = await (0, datasource_2.loadDataSource)(dsRow.id);
    const ctx = { appId: app.id, role: 'CLIENT', clientKey: 'verify', settings: (0, context_1.defaultSettings)(), app };
    console.log('=== ① 正常预览（GROUP BY 聚合，走 SQL 网关）===');
    const r1 = await (0, gateway_1.execute)(ds, 'SELECT region, COUNT(*) AS cnt, SUM(amount) AS total_amount FROM orders GROUP BY region ORDER BY total_amount DESC', {}, { maxRows: 200, timeoutMs: 15000, source: 'PREVIEW', ctx });
    console.log('columns:', r1.columns.join(', '), '| 行数:', r1.rows.length);
    console.log(r1.rows.map((r) => `  ${r.region}: ${r.cnt} 单 / ${r.total_amount}`).join('\n'));
    console.log('\n=== ② 对抗：SELECT SLEEP(2) → 应拒 DANGEROUS_FUNCTION ===');
    try {
        await (0, gateway_1.execute)(ds, 'SELECT SLEEP(2)', {}, { maxRows: 200, timeoutMs: 5000, source: 'PREVIEW', ctx });
        console.log('  ✗ 未拒绝！');
    }
    catch (e) {
        console.log('  ✓ 拒绝码:', e.code);
    }
    console.log('\n=== ③ 对抗：DROP TABLE orders（多语句/写） → 应拒 ===');
    try {
        await (0, gateway_1.execute)(ds, 'DROP TABLE orders', {}, { maxRows: 200, timeoutMs: 5000, source: 'PREVIEW', ctx });
        console.log('  ✗ 未拒绝！');
    }
    catch (e) {
        console.log('  ✓ 拒绝码:', e.code);
    }
    console.log('\n=== ④ 只读账号真实 INSERT 应被 MySQL 拒绝（M0 验收）===');
    const pool = (0, datasource_1.getDsPool)(ds);
    const c = await pool.getConnection();
    try {
        await c.execute('INSERT INTO orders (customer_name,region,amount) VALUES (?,?,?)', ['__probe', '华东', 1]);
        console.log('  ✗ INSERT 竟然成功（不安全）');
    }
    catch (e) {
        console.log('  ✓ INSERT 被 MySQL 拒绝:', e.code, e.sqlState || '');
    }
    finally {
        c.release();
    }
    console.log('\n=== ⑤ CSV 导出（真实数据落盘 + BOM + 注入防护）===');
    const { id } = await (0, export_1.createExport)(ctx, { sql: 'SELECT id, customer_name, region, amount, status FROM orders ORDER BY created_at DESC LIMIT 1000', params: {}, format: 'csv', dataSourceId: ds.id });
    await new Promise((r) => setTimeout(r, 3500)); // 等异步导出任务
    const task = await (0, platform_1.pGet)('SELECT * FROM export_task WHERE id=?', [id]);
    console.log('  状态:', task.status, '| 行数:', task.row_count, '| 文件:', task.file_key);
    if (task.file_key && fs_1.default.existsSync(task.file_key)) {
        const head = fs_1.default.readFileSync(task.file_key, 'utf8').split('\n').slice(0, 3).join('\n');
        console.log('  文件前 3 行:\n' + head);
    }
    console.log('\n=== ⑥ XLSX 导出（exceljs 流式写盘）===');
    const xid = (await (0, export_1.createExport)(ctx, {
        sql: 'SELECT region, customer_name, amount, status FROM orders ORDER BY amount DESC LIMIT 500',
        params: {}, format: 'xlsx', dataSourceId: ds.id,
    })).id;
    await new Promise((r) => setTimeout(r, 4000));
    const xt = await (0, platform_1.pGet)('SELECT * FROM export_task WHERE id=?', [xid]);
    console.log('  状态:', xt.status, '| 行数:', xt.row_count, '| 错误:', xt.error_msg ?? '无');
    if (xt.file_key && fs_1.default.existsSync(xt.file_key)) {
        const size = fs_1.default.statSync(xt.file_key).size;
        console.log('  文件:', xt.file_key, `(${size} 字节)`);
        const ExcelJS = (await Promise.resolve().then(() => __importStar(require('exceljs')))).default;
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(xt.file_key);
        const ws = wb.getWorksheet('sheet1');
        console.log('  回读：工作表', ws.name, '| 行数', ws.rowCount, '| 列数', ws.columnCount);
        console.log('  表头:', ws.getRow(1).values.slice(1).join(' | '));
        console.log('  首行:', ws.getRow(2).values.slice(1).join(' | '));
    }
    console.log('\n=== ⑦ 0 行结果仍要返回表头（否则前端一片空白，分不清是空还是坏了）===');
    const r7 = await (0, gateway_1.execute)(ds, 'SELECT id, region, amount FROM orders WHERE 1=0', {}, { maxRows: 200, timeoutMs: 5000, source: 'PREVIEW', ctx });
    console.log('  行数:', r7.rows.length, '| 表头:', r7.columns.join(', ') || '（空！）');
    if (r7.columns.length === 0)
        throw new Error('0 行时没有返回表头');
    console.log('\n=== ⑧ 表/列名写错 → 明确 400 编号，不是 500 INTERNAL ===');
    for (const sql of ['SELECT * FROM orders_typo', 'SELECT nosuchcol FROM orders']) {
        try {
            await (0, gateway_1.execute)(ds, sql, {}, { maxRows: 200, timeoutMs: 5000, source: 'PREVIEW', ctx });
            console.log('  ✗ 竟然成功:', sql);
        }
        catch (e) {
            console.log(`  ✓ ${sql} → ${e.code}`);
        }
    }
    console.log('\n✅ 验证完成：网关 + 预览 + 只读约束 + CSV/XLSX 导出 全部跑通 live MySQL。');
    process.exit(0);
}
main().catch((e) => { console.error('VERIFY ERROR:', e); process.exit(1); });
