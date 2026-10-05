"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// NL2SQL 在线冒烟（M2）：真实调用 DeepSeek 端点生成 SQL，并用网关预览验证可安全执行。
// 运行（需先 tsc 编译）：node -r ./scripts/alias.cjs .verify-build/scripts/smoke-nl2sql.js
const fs_1 = __importDefault(require("fs"));
const platform_1 = require("@/server/db/platform");
const datasource_1 = require("@/server/services/datasource");
const generation_1 = require("@/server/services/generation");
const gateway_1 = require("@/server/sql/gateway");
const context_1 = require("@/server/context");
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
        throw new Error('未找到 demo 应用');
    const dsRow = await (0, platform_1.pGet)('SELECT * FROM data_source WHERE app_id=?', [app.id]);
    const ds = await (0, datasource_1.loadDataSource)(dsRow.id);
    const ctx = { appId: app.id, role: 'DEVELOPER', clientKey: 'smoke', settings: (0, context_1.defaultSettings)(), app };
    console.log('=== M2 NL2SQL 在线生成（DeepSeek）===');
    const res = await (0, generation_1.generateSql)(ctx, {
        prompt: '统计各地区订单的总金额和订单数，按总金额降序',
        dataSourceId: ds.id,
    });
    console.log('mode:', res.mode);
    if (res.sql)
        console.log('生成 SQL:\n' + res.sql);
    if (res.reason)
        console.log('降级原因:', res.reason);
    if (res.sql) {
        console.log('\n=== 用 SQL 网关预览验证生成结果可安全执行 ===');
        const r = await (0, gateway_1.execute)(ds, res.sql, {}, { maxRows: 200, timeoutMs: 15000, source: 'PREVIEW', ctx });
        console.log('columns:', r.columns.join(', '), '| 行数:', r.rows.length);
        console.log(r.rows.map((x) => '  ' + JSON.stringify(x)).join('\n'));
    }
    console.log('\n✅ NL2SQL 冒烟完成。');
    process.exit(0);
}
main().catch((e) => { console.error('NL2SQL SMOKE ERROR:', e); process.exit(1); });
