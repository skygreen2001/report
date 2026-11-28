// 平台元库（SQLite 单文件，sql.js / WebAssembly 实现：纯 JS 依赖，无需原生编译）。
//
// 设计要点：
//   · 元库文件默认落在 ${TMPDIR:-/tmp}/report-platform/platform.db，首次访问自动建表并初始化平台根应用；
//   · 每次写入后把内存库导出落盘（先写 .tmp 再 rename，避免写一半留下坏文件）；
//   · 所有查询串行执行（单连接），事务期间用 AsyncLocalStorage 让同上下文的读写复用当前事务；
//   · 对上层保持原有 pQuery / pGet / pRun / platformTx 签名，业务代码无需感知驱动变化。
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PLATFORM_SCHEMA_SQL, PLATFORM_TRIGGERS_SQL } from './schema';

export type Row = Record<string, any>;

// 与 mysql2 的 ResultSetHeader 对齐，业务代码用到的字段都在这里
export interface RunResult {
  insertId: number;
  affectedRows: number;
  changedRows: number;
}

interface SqlJsStatement {
  bind(params: unknown[]): boolean;
  step(): boolean;
  getAsObject(): Row;
  free(): void;
}

interface SqlJsDatabase {
  run(sql: string, params?: unknown[]): unknown;
  prepare(sql: string): SqlJsStatement;
  exec(sql: string): { columns: string[]; values: unknown[][] }[];
  export(): Uint8Array;
  close(): void;
  getRowsModified(): number;
}

const g = globalThis as unknown as {
  __platformDb?: Promise<SqlJsDatabase>;
  __platformChain?: Promise<unknown>;
  __platformBroken?: { until: number };
};

// 事务上下文：事务内的查询不再进入串行队列（否则自我等待死锁）
const txStore = new AsyncLocalStorage<{ db: SqlJsDatabase }>();

export function platformDbPath(): string {
  const configured = process.env.PLATFORM_DB_PATH?.trim();
  if (configured) return path.resolve(configured);
  // 部署平台只允许写 TMPDIR，元库作为运行期状态放在临时目录（进程重启后重建）
  const tmp = process.env.TMPDIR?.trim() || '/tmp';
  return path.join(tmp, 'report-platform', 'platform.db');
}

function loadWasm(): Buffer | undefined {
  // 显式提供 wasm，避免打包后 locateFile 解析不到 node_modules
  const candidates = [
    path.join(process.cwd(), 'node_modules/sql.js/dist/sql-wasm.wasm'),
    path.join(process.cwd(), '.next/standalone/node_modules/sql.js/dist/sql-wasm.wasm'),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return fs.readFileSync(file);
  }
  return undefined;
}

function persist(db: SqlJsDatabase): void {
  const file = platformDbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, Buffer.from(db.export()));
  fs.renameSync(tmp, file);
}

async function openDatabase(): Promise<SqlJsDatabase> {
  const initSqlJs = ((await import('sql.js')) as unknown as { default: (cfg?: unknown) => Promise<any> }).default;
  const SQL = await initSqlJs({ wasmBinary: loadWasm() });

  const file = platformDbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let db: SqlJsDatabase;
  if (fs.existsSync(file)) {
    try {
      db = new SQL.Database(fs.readFileSync(file));
      // 打开后跑一次完整性检查：坏文件直接重建，避免整个服务起不来
      const check = db.exec('PRAGMA integrity_check');
      const ok = check[0]?.values?.[0]?.[0] === 'ok';
      if (!ok) throw new Error('integrity check failed');
    } catch {
      db = new SQL.Database();
    }
  } else {
    db = new SQL.Database();
  }

  db.run(PLATFORM_SCHEMA_SQL);
  db.run(PLATFORM_TRIGGERS_SQL);
  persist(db);
  return db;
}

// 单连接 + 串行队列：SQLite 写入无法并发，串行也顺带避免语句交错
function serialize<T>(fn: (db: SqlJsDatabase) => Promise<T> | T): Promise<T> {
  const prev = g.__platformChain ?? Promise.resolve();
  const next = prev.then(async () => fn(await getDb()));
  g.__platformChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function getDb(): Promise<SqlJsDatabase> {
  if (!g.__platformDb) {
    g.__platformDb = openDatabase().catch((e) => {
      g.__platformDb = undefined;
      throw e;
    });
  }
  return g.__platformDb;
}

// 预先初始化（启动/首个请求时调用，失败会重新尝试）
export async function initPlatformDb(): Promise<void> {
  await getDb();
}

// ---- 参数归一：sql.js 只接受 null / number / string / Uint8Array ----
function normalizeParams(params: unknown[] = []): unknown[] {
  return params.map((v) => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v instanceof Date) return v.toISOString().slice(0, 19).replace('T', ' ');
    return v;
  });
}

function all(db: SqlJsDatabase, sql: string, params: unknown[]): Row[] {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(normalizeParams(params));
    const rows: Row[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

function run(db: SqlJsDatabase, sql: string, params: unknown[]): RunResult {
  db.run(sql, normalizeParams(params));
  const affectedRows = db.getRowsModified();
  const inserted = db.exec('SELECT last_insert_rowid() AS id')[0]?.values?.[0]?.[0];
  return {
    insertId: typeof inserted === 'number' ? inserted : Number(inserted ?? 0),
    affectedRows,
    changedRows: affectedRows,
  };
}

function persistIfNeeded(db: SqlJsDatabase): void {
  if (!txStore.getStore()) persist(db);
}

export async function pQuery<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const tx = txStore.getStore();
  if (tx) return all(tx.db, sql, params) as unknown as T[];
  return serialize((db) => all(db, sql, params)) as unknown as Promise<T[]>;
}

export async function pGet<T = Row>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await pQuery<T>(sql, params);
  return rows[0];
}

export async function pRun(sql: string, params: unknown[] = []): Promise<RunResult> {
  const tx = txStore.getStore();
  if (tx) return run(tx.db, sql, params);
  return serialize((db) => {
    const r = run(db, sql, params);
    persistIfNeeded(db);
    return r;
  });
}

export interface Tx {
  query: <T = Row>(sql: string, params?: any[]) => Promise<T[]>;
  get: <T = Row>(sql: string, params?: any[]) => Promise<T | undefined>;
  run: (sql: string, params?: any[]) => Promise<RunResult>;
}

function makeTx(db: SqlJsDatabase): Tx {
  return {
    query: async (sql, params = []) => all(db, sql, params) as unknown as any[],
    get: async (sql, params = []) => all(db, sql, params)[0] as unknown as any,
    run: async (sql, params = []) => run(db, sql, params),
  };
}

export async function platformTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  // 已在事务里（极少见）：用保存点嵌套，避免重复 BEGIN
  const current = txStore.getStore();
  if (current) {
    const sp = `sp_${Math.random().toString(36).slice(2, 10)}`;
    current.db.run(`SAVEPOINT ${sp}`);
    try {
      const result = await fn(makeTx(current.db));
      current.db.run(`RELEASE ${sp}`);
      return result;
    } catch (e) {
      current.db.run(`ROLLBACK TO ${sp}`);
      current.db.run(`RELEASE ${sp}`);
      throw e;
    }
  }

  return serialize(async (db) => {
    db.run('BEGIN IMMEDIATE');
    try {
      const result = await txStore.run({ db }, () => fn(makeTx(db)));
      db.run('COMMIT');
      persist(db);
      return result;
    } catch (e) {
      try {
        db.run('ROLLBACK');
      } catch {
        /* 已经回滚或事务未开启 */
      }
      throw e;
    }
  });
}

// 熔断：元库不可用时快速失败，不堆积（REQ-NFR-04）。挂在 globalThis 上，dev 热重载不丢。
export function markPlatformDown(ms: number) {
  g.__platformBroken = { until: Date.now() + ms };
}
export function assertPlatformUp() {
  const b = g.__platformBroken;
  if (b && Date.now() < b.until) throw new Error('PLATFORM_UNAVAILABLE');
  if (b) g.__platformBroken = undefined;
}
