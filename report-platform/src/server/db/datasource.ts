// 业务库连接池（按 dsId 隔离）+ DataSourceAdapter 适配点（doc §3、§17.3）。
// 每个连接池 multipleStatements:false（堵死堆叠注入），账号为只读账号。
import mysql from 'mysql2/promise';
import { decrypt } from '../crypto';
import type { DataSourceRow } from '@/lib/types';

// ★ 同 platform.ts：挂在 globalThis，避免 dev 热重载反复建池把 MySQL 连接打满
const g = globalThis as unknown as { __dsPools?: Map<string, mysql.Pool> };
const pools: Map<string, mysql.Pool> = g.__dsPools ?? (g.__dsPools = new Map());

// 删除数据源时释放缓存中的连接池（顺手关闭，防止连接泄漏；关闭失败不影响删除）
export function releaseDsPool(id: string): void {
  const p = pools.get(id);
  if (!p) return;
  pools.delete(id);
  void p.end().catch(() => {});
}

export function getDsPool(ds: DataSourceRow): mysql.Pool {
  let pool = pools.get(ds.id);
  if (!pool) {
    pool = mysql.createPool({
      host: ds.host,
      port: ds.port,
      user: ds.username,
      password: decrypt(ds.password_enc),
      database: ds.database_name,
      multipleStatements: false, // ★ 关闭多语句（REQ-SEC-02）
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 20,
      charset: 'utf8mb4',
      connectTimeout: 10_000,
      idleTimeout: 30_000,
    });
    pools.set(ds.id, pool);
  }
  return pool;
}

// 用明文凭据临时建池（测试连接用），不入缓存
export function makeTempPool(cfg: { host: string; port: number; user: string; password: string; database: string }) {
  return mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    multipleStatements: false,
    connectionLimit: 2,
    charset: 'utf8mb4',
    connectTimeout: 10_000,
  });
}

// DataSourceAdapter 抽象（一期仅 MysqlAdapter）
export interface DataSourceAdapter {
  connect(): Promise<void>;
  testReadonly(): Promise<boolean>;
  fetchCatalog(): Promise<unknown>;
  getPool(): mysql.Pool;
}

export class MysqlAdapter implements DataSourceAdapter {
  constructor(private ds: DataSourceRow) {}
  async connect() {
    const p = getDsPool(this.ds);
    const c = await p.getConnection();
    c.release();
  }
  // 只读校验：能 SELECT 1，且尝试 INSERT 必失败（M0 验收）
  async testReadonly(): Promise<boolean> {
    const p = getDsPool(this.ds);
    const c = await p.getConnection();
    try {
      await c.execute('SELECT 1');
      try {
        await c.execute(`CREATE TEMPORARY TABLE IF NOT EXISTS __ro_probe (x INT)`);
        await c.execute('INSERT INTO __ro_probe (x) VALUES (1)');
        return false; // 能写 → 不是只读
      } catch {
        return true; // 写被拒 → 只读
      }
    } finally {
      c.release();
    }
  }
  async fetchCatalog() {
    const p = getDsPool(this.ds);
    const [tables] = await p.execute(
      'SELECT table_name AS table_name FROM information_schema.tables WHERE table_schema = ?',
      [this.ds.database_name],
    );
    return tables;
  }
  getPool() {
    return getDsPool(this.ds);
  }
}
