// 平台元库连接池 + 查询/事务封装（doc §3 server/db/platform.ts）。
// 元库使用 root/root（本机）。生产应改为专用账号。
import mysql from 'mysql2/promise';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';

// ★ 池子挂到 globalThis：Next dev 每次热重载都会重新执行本模块，
// 若用模块级变量会每改一次代码就新建一个连接池，旧池的连接要等 idleTimeout 才释放，
// 积累几次就把 MySQL 的 max_connections（默认 151）打满，表现为全站 500。
const g = globalThis as unknown as { __platformPool?: mysql.Pool; __platformBroken?: { until: number } };

function getPool(): mysql.Pool {
  if (!g.__platformPool) {
    g.__platformPool = mysql.createPool({
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

export async function pQuery<T = RowDataPacket>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await getPool().execute(sql, params as any);
  return rows as T[];
}

export async function pGet<T = RowDataPacket>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await pQuery<T>(sql, params);
  return rows[0];
}

export async function pRun(sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const [r] = await getPool().execute(sql, params as any);
  return r as ResultSetHeader;
}

export interface Tx {
  query: <T = RowDataPacket>(sql: string, params?: any[]) => Promise<T[]>;
  get: <T = RowDataPacket>(sql: string, params?: any[]) => Promise<T | undefined>;
  run: (sql: string, params?: any[]) => Promise<ResultSetHeader>;
}

export async function platformTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const tx: Tx = {
      query: async (sql, params: any[] = []) => {
        const [rows] = await conn.execute(sql, params);
        return rows as any;
      },
      get: async (sql, params: any[] = []) => {
        const [rows] = (await conn.execute(sql, params)) as any[];
        return rows[0] as any;
      },
      run: async (sql, params: any[] = []) => {
        const [r] = await conn.execute(sql, params);
        return r as ResultSetHeader;
      },
    };
    const result = await fn(tx);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// 熔断：元库不可用时快速失败，不堆积（REQ-NFR-04）。同样挂在 globalThis 上。
export function markPlatformDown(ms: number) {
  g.__platformBroken = { until: Date.now() + ms };
}
export function assertPlatformUp() {
  const b = g.__platformBroken;
  if (b && Date.now() < b.until) throw new Error('PLATFORM_UNAVAILABLE');
  if (b) g.__platformBroken = undefined;
}
