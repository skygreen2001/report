"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.pQuery = pQuery;
exports.pGet = pGet;
exports.pRun = pRun;
exports.platformTx = platformTx;
exports.markPlatformDown = markPlatformDown;
exports.assertPlatformUp = assertPlatformUp;
// 平台元库连接池 + 查询/事务封装（doc §3 server/db/platform.ts）。
// 元库使用 root/root（本机）。生产应改为专用账号。
const promise_1 = __importDefault(require("mysql2/promise"));
// ★ 池子挂到 globalThis：Next dev 每次热重载都会重新执行本模块，
// 若用模块级变量会每改一次代码就新建一个连接池，旧池的连接要等 idleTimeout 才释放，
// 积累几次就把 MySQL 的 max_connections（默认 151）打满，表现为全站 500。
const g = globalThis;
function getPool() {
    if (!g.__platformPool) {
        g.__platformPool = promise_1.default.createPool({
            host: process.env.PLATFORM_DB_HOST ?? '127.0.0.1',
            port: Number(process.env.PLATFORM_DB_PORT ?? 3306),
            user: process.env.PLATFORM_DB_USER ?? 'root',
            password: process.env.PLATFORM_DB_PASSWORD ?? '',
            database: process.env.PLATFORM_DB_NAME ?? 'report_platform',
            waitForConnections: true,
            connectionLimit: 10,
            charset: 'utf8mb4',
            connectTimeout: 10_000,
            idleTimeout: 30_000, // 空闲连接尽快回收，避免热重载留下的一堆池子占着不放
        });
    }
    return g.__platformPool;
}
async function pQuery(sql, params = []) {
    const [rows] = await getPool().execute(sql, params);
    return rows;
}
async function pGet(sql, params = []) {
    const rows = await pQuery(sql, params);
    return rows[0];
}
async function pRun(sql, params = []) {
    const [r] = await getPool().execute(sql, params);
    return r;
}
async function platformTx(fn) {
    const conn = await getPool().getConnection();
    try {
        await conn.beginTransaction();
        const tx = {
            query: async (sql, params = []) => {
                const [rows] = await conn.execute(sql, params);
                return rows;
            },
            get: async (sql, params = []) => {
                const [rows] = (await conn.execute(sql, params));
                return rows[0];
            },
            run: async (sql, params = []) => {
                const [r] = await conn.execute(sql, params);
                return r;
            },
        };
        const result = await fn(tx);
        await conn.commit();
        return result;
    }
    catch (e) {
        await conn.rollback();
        throw e;
    }
    finally {
        conn.release();
    }
}
// 熔断：元库不可用时快速失败，不堆积（REQ-NFR-04）。同样挂在 globalThis 上。
function markPlatformDown(ms) {
    g.__platformBroken = { until: Date.now() + ms };
}
function assertPlatformUp() {
    const b = g.__platformBroken;
    if (b && Date.now() < b.until)
        throw new Error('PLATFORM_UNAVAILABLE');
    if (b)
        g.__platformBroken = undefined;
}
