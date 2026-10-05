// ④ 执行：只读会话 + prepared statement（doc §6.4）。multipleStatements:false 在连接池已设。
import { getDsPool } from '../db/datasource';
import type { DataSourceRow } from '@/lib/types';

// 在只读事务内执行 fn（REQ-SEC-04 只读事务 + REQ-SEC-03 超时）
export async function withReadonlyConn<T>(ds: DataSourceRow, timeoutMs: number, fn: (conn: any) => Promise<T>): Promise<T> {
  const pool = getDsPool(ds);
  const conn = await pool.getConnection();
  try {
    await conn.query('SET SESSION TRANSACTION READ ONLY');
    await conn.query(`SET SESSION max_execution_time = ${Number(timeoutMs)}`);
    return await fn(conn);
  } finally {
    conn.release();
  }
}

// 导出分页读取（doc §6.5）：只读事务内分页，快照一致；LIMIT/OFFSET 为代码生成的数字，安全。
export async function* pageQuery(conn: any, sql: string, values: unknown[], size = 5000, max = 50_000) {
  let offset = 0;
  let fetched = 0;
  while (fetched < max) {
    const [rows] = await conn.execute(`${sql} LIMIT ${size} OFFSET ${offset}`, values);
    if (!rows.length) return;
    yield rows as any[];
    fetched += rows.length;
    if (rows.length < size) return;
    offset += rows.length;
  }
}
