"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadDataSource = loadDataSource;
exports.listDataSources = listDataSources;
exports.createDataSource = createDataSource;
exports.setDefaultDataSource = setDefaultDataSource;
exports.resolveDefaultDataSourceId = resolveDefaultDataSourceId;
exports.testDataSource = testDataSource;
exports.refreshCatalog = refreshCatalog;
exports.getCatalog = getCatalog;
// 数据源服务（doc §5、§17.3）。CREATE 时加密密码；LIST 不含凭据；TEST 校验只读。
const platform_1 = require("../db/platform");
const datasource_1 = require("../db/datasource");
const node_crypto_1 = __importDefault(require("node:crypto"));
const crypto_1 = require("../crypto");
const datasource_2 = require("../db/datasource");
const errors_1 = require("../errors");
const context_1 = require("../context");
async function loadDataSource(id) {
    const ds = await (0, platform_1.pGet)('SELECT * FROM data_source WHERE id=?', [id]);
    if (!ds)
        throw new errors_1.HttpError(404, 'DATA_SOURCE_NOT_FOUND');
    return ds;
}
async function listDataSources(appId) {
    const rows = await (0, platform_1.pQuery)('SELECT id,app_id,name,host,port,database_name,username,status,catalog_json,sensitive_columns_json,created_at,updated_at FROM data_source WHERE app_id=? ORDER BY created_at', [appId]);
    return rows;
}
async function createDataSource(ctx, input) {
    const id = node_crypto_1.default.randomUUID();
    await (0, platform_1.pRun)(`INSERT INTO data_source (id,app_id,name,host,port,database_name,username,password_enc,status,sensitive_columns_json)
     VALUES (?,?,?,?,?,?,?,?,?,?)`, [
        id, ctx.appId, input.name, input.host, input.port, input.database_name, input.username,
        (0, crypto_1.encrypt)(input.password), 'ACTIVE', input.sensitive_columns_json ?? null,
    ]);
    // 应用还没有默认数据源时，自动把新建的这个设为默认（否则甲方侧会因 defaultDs 为空而无法使用）
    const app = await (0, platform_1.pGet)('SELECT * FROM application WHERE id=?', [ctx.appId]);
    if (app && !(0, context_1.parseSettings)(app.settings_json).defaultDs) {
        await writeDefaultDataSource(app, id);
    }
    return id;
}
// 写回 application.settings_json.defaultDs 并即时失效应用缓存（REQ-ACC-07）
async function writeDefaultDataSource(app, dsId) {
    const settings = (0, context_1.parseSettings)(app.settings_json);
    settings.defaultDs = dsId;
    await (0, platform_1.pRun)('UPDATE application SET settings_json=? WHERE id=?', [JSON.stringify(settings), app.id]);
    (0, context_1.invalidateAppCache)(app.host, app.path_prefix);
}
// 设为默认数据源（仅 DEVELOPER）
async function setDefaultDataSource(ctx, id) {
    const ds = await (0, platform_1.pGet)('SELECT id FROM data_source WHERE id=? AND app_id=?', [id, ctx.appId]);
    if (!ds)
        throw new errors_1.HttpError(404, 'DATA_SOURCE_NOT_FOUND');
    const app = await (0, platform_1.pGet)('SELECT * FROM application WHERE id=?', [ctx.appId]);
    if (!app)
        throw new errors_1.HttpError(404, 'APP_NOT_FOUND');
    await writeDefaultDataSource(app, ds.id);
}
// 解析「实际可用」的默认数据源：settings.defaultDs 为空/已失效时，回落到该应用第一个 ACTIVE 数据源。
// 这样即使开发者只建了数据源却没显式点「设为默认」，甲方侧也不会被卡住。
async function resolveDefaultDataSourceId(ctx) {
    const want = ctx.settings.defaultDs;
    if (want) {
        const row = await (0, platform_1.pGet)(`SELECT id FROM data_source WHERE id=? AND app_id=? AND status='ACTIVE'`, [want, ctx.appId]);
        if (row)
            return row.id;
    }
    const rows = await (0, platform_1.pQuery)(`SELECT id FROM data_source WHERE app_id=? AND status='ACTIVE' ORDER BY created_at LIMIT 1`, [ctx.appId]);
    return rows[0]?.id ?? null;
}
// 测试连接 + 只读校验（M0 验收：INSERT 必失败 → 返回 isReadonly=false）
async function testDataSource(id) {
    const ds = await loadDataSource(id);
    const adapter = new datasource_1.MysqlAdapter(ds);
    try {
        await adapter.connect();
        const isReadonly = await adapter.testReadonly();
        return { ok: true, isReadonly };
    }
    catch (e) {
        return { ok: false, isReadonly: false };
    }
    finally {
        // 释放临时连接（池由缓存持有，这里仅探活）
        void (0, datasource_2.getDsPool)(ds);
    }
}
// 刷新元数据缓存（直接查 information_schema，绕过 SQL 网关——这是平台自理的只读查询）
async function refreshCatalog(id) {
    const ds = await loadDataSource(id);
    const pool = (0, datasource_2.getDsPool)(ds);
    const conn = await pool.getConnection();
    try {
        // 注意：information_schema 的列名在 MySQL 中是大写（TABLE_NAME），必须用 AS 显式别名，
        // 否则 mysql2 返回的 RowDataPacket 键为大写，t.table_name 恒为 undefined。
        const [tables] = await conn.execute(`SELECT table_name AS table_name, table_comment AS table_comment
       FROM information_schema.tables WHERE table_schema=?`, [ds.database_name]);
        const catalog = [];
        for (const t of tables) {
            const [cols] = await conn.execute(`SELECT column_name AS column_name, column_type AS column_type, column_comment AS column_comment
         FROM information_schema.columns WHERE table_schema=? AND table_name=?
         ORDER BY ordinal_position`, [ds.database_name, t.table_name]);
            catalog.push({ table: t.table_name, comment: t.table_comment, columns: cols });
        }
        await (0, platform_1.pRun)('UPDATE data_source SET catalog_json=? WHERE id=?', [JSON.stringify(catalog), id]);
    }
    finally {
        conn.release();
    }
}
async function getCatalog(ds) {
    if (ds.catalog_json) {
        try {
            return JSON.parse(ds.catalog_json);
        }
        catch {
            /* fallthrough */
        }
    }
    await refreshCatalog(ds.id);
    const fresh = await loadDataSource(ds.id);
    return fresh.catalog_json ? JSON.parse(fresh.catalog_json) : [];
}
