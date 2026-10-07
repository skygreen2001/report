// 数据源服务（doc §5、§17.3）。CREATE 时加密密码；LIST 不含凭据；TEST 校验只读。
import { pGet, pQuery, pRun, platformTx } from '../db/platform';
import { MysqlAdapter, makeTempPool } from '../db/datasource';
import crypto from 'node:crypto';
import { encrypt } from '../crypto';
import { getDsPool, releaseDsPool } from '../db/datasource';
import { HttpError } from '../errors';
import { parseSettings, invalidateAppCache } from '../context';
import type { ApplicationRow, DataSourceRow, RoleContext } from '@/lib/types';

export async function loadDataSource(id: string): Promise<DataSourceRow> {
  const ds = await pGet<DataSourceRow>('SELECT * FROM data_source WHERE id=?', [id]);
  if (!ds) throw new HttpError(404, 'DATA_SOURCE_NOT_FOUND');
  return ds;
}

export async function listDataSources(appId: string): Promise<Omit<DataSourceRow, 'password_enc'>[]> {
  const rows = await pQuery<DataSourceRow>(
    'SELECT id,app_id,name,host,port,database_name,username,status,catalog_json,sensitive_columns_json,created_at,updated_at FROM data_source WHERE app_id=? ORDER BY created_at',
    [appId],
  );
  return rows;
}

export interface CreateDsInput {
  name: string;
  host: string;
  port: number;
  database_name: string;
  username: string;
  password: string;
  sensitive_columns_json?: string | null;
}

export async function createDataSource(ctx: RoleContext, input: CreateDsInput): Promise<string> {
  // 去重：同一应用内连接信息（host/port/库名/账号）完全相同视为重复，避免误建两份一模一样的数据源
  const dup = await pGet<{ id: string }>(
    `SELECT id FROM data_source WHERE app_id=? AND host=? AND port=? AND database_name=? AND username=? LIMIT 1`,
    [ctx.appId, input.host, input.port, input.database_name, input.username],
  );
  if (dup) {
    throw new HttpError(409, 'DATA_SOURCE_DUPLICATE', '该数据源已存在（host / 端口 / 库名 / 账号完全相同），请勿重复添加。');
  }
  const id = crypto.randomUUID();
  await pRun(
    `INSERT INTO data_source (id,app_id,name,host,port,database_name,username,password_enc,status,sensitive_columns_json)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      id, ctx.appId, input.name, input.host, input.port, input.database_name, input.username,
      encrypt(input.password), 'ACTIVE', input.sensitive_columns_json ?? null,
    ],
  );
  // 应用还没有默认数据源时，自动把新建的这个设为默认（否则甲方侧会因 defaultDs 为空而无法使用）
  const app = await pGet<ApplicationRow>('SELECT * FROM application WHERE id=?', [ctx.appId]);
  if (app && !parseSettings(app.settings_json).defaultDs) {
    await writeDefaultDataSource(app, id);
  }
  return id;
}

// 写回 application.settings_json.defaultDs 并即时失效应用缓存（REQ-ACC-07）
async function writeDefaultDataSource(app: ApplicationRow, dsId: string | null): Promise<void> {
  const settings = parseSettings(app.settings_json);
  settings.defaultDs = dsId;
  await pRun('UPDATE application SET settings_json=? WHERE id=?', [JSON.stringify(settings), app.id]);
  invalidateAppCache(app.host, app.path_prefix);
}

// 设为默认数据源（仅 DEVELOPER）
export async function setDefaultDataSource(ctx: RoleContext, id: string): Promise<void> {
  const ds = await pGet<DataSourceRow>('SELECT id FROM data_source WHERE id=? AND app_id=?', [id, ctx.appId]);
  if (!ds) throw new HttpError(404, 'DATA_SOURCE_NOT_FOUND');
  const app = await pGet<ApplicationRow>('SELECT * FROM application WHERE id=?', [ctx.appId]);
  if (!app) throw new HttpError(404, 'APP_NOT_FOUND');
  await writeDefaultDataSource(app, ds.id);
}

// 删除数据源（仅 DEVELOPER）。
// 安全点：①跨应用归属校验（404）；②被报表/运行记录引用时，若未指定改派目标则拦截（409），
//   指定 targetDsId 则先把依赖改派到同源目标源（同事务）再删，避免悬空外键；
// ③若删除的是应用默认数据源，自动回落到该应用下一个 ACTIVE 数据源（无残留则置空，由 bootstrap 兜底解析）；
// ④释放业务库连接池缓存、即时失效应用缓存。
export interface DeleteDsResult {
  defaultDsChanged: boolean;
  newDefaultDs: string | null;
  reassignedTo: string | null;
  reassignedCount: number;
}
export async function deleteDataSource(ctx: RoleContext, id: string, targetDsId?: string): Promise<DeleteDsResult> {
  if (ctx.role !== 'DEVELOPER') throw new HttpError(403, 'FORBIDDEN');
  // 跨应用归属校验：别的开发者删不到你应用的数据源
  const ds = await pGet<DataSourceRow>('SELECT * FROM data_source WHERE id=? AND app_id=?', [id, ctx.appId]);
  if (!ds) throw new HttpError(404, 'DATA_SOURCE_NOT_FOUND');

  // 依赖检查：报表 / 运行记录 是否还指着这个数据源（sql_version 不绑定数据源，无需检查）
  const [r1] = await pQuery<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM report WHERE data_source_id=?', [id]);
  const [r3] = await pQuery<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM run_record WHERE data_source_id=?', [id]);
  const used = (r1?.cnt ?? 0) + (r3?.cnt ?? 0);

  let reassignedTo: string | null = null;
  let reassignedCount = 0;

  if (used > 0) {
    if (!targetDsId) {
      // 没给改派目标：直接拦截，提示改用「改派并删除」
      throw new HttpError(
        409,
        'DATA_SOURCE_IN_USE',
        `该数据源仍被 ${used} 条记录引用（报表 / 运行记录），无法直接删除。可把它关联的报表改派到其他同源数据源，或使用「改派并删除」。`,
      );
    }
    // 校验目标源：必须是同应用、存在、非自身、ACTIVE
    if (targetDsId === id) throw new HttpError(400, 'BAD_TARGET', '改派目标不能是被删除的数据源本身');
    const target = await pGet<DataSourceRow>(
      'SELECT * FROM data_source WHERE id=? AND app_id=? AND status=?', [targetDsId, ctx.appId, 'ACTIVE'],
    );
    if (!target) throw new HttpError(404, 'TARGET_NOT_FOUND', '改派目标数据源不存在或不可用');
    // 同事务改派（报表 + 运行记录）→ 后续删除原子完成，不会留悬空外键
    reassignedCount = await platformTx(async (tx) => {
      const a = await tx.run('UPDATE report SET data_source_id=? WHERE data_source_id=? AND app_id=?', [targetDsId, id, ctx.appId]);
      const b = await tx.run('UPDATE run_record SET data_source_id=? WHERE data_source_id=? AND app_id=?', [targetDsId, id, ctx.appId]);
      return (a.affectedRows ?? 0) + (b.affectedRows ?? 0);
    });
    reassignedTo = targetDsId;
  }

  // 若删的是默认数据源，先找回落项（排除自身），再写回 settings
  let defaultDsChanged = false;
  let newDefaultDs: string | null = null;
  const app = await pGet<ApplicationRow>('SELECT * FROM application WHERE id=?', [ctx.appId]);
  if (app && parseSettings(app.settings_json).defaultDs === id) {
    const fallback = await pGet<{ id: string }>(
      `SELECT id FROM data_source WHERE app_id=? AND id<>? AND status='ACTIVE' ORDER BY created_at LIMIT 1`,
      [ctx.appId, id],
    );
    newDefaultDs = fallback?.id ?? null;
    await writeDefaultDataSource(app, newDefaultDs);
    defaultDsChanged = true;
  }

  // 释放业务库连接池缓存（关闭物理连接，防止泄漏）
  releaseDsPool(id);
  // 硬删除（已排除/改派被依赖的情况，不会留悬空外键）
  await pRun('DELETE FROM data_source WHERE id=? AND app_id=?', [id, ctx.appId]);
  // 即时失效应用缓存，让 bootstrap 立刻不带这个数据源
  if (app) invalidateAppCache(app.host, app.path_prefix);
  return { defaultDsChanged, newDefaultDs, reassignedTo, reassignedCount };
}

// 解析「实际可用」的默认数据源：settings.defaultDs 为空/已失效时，回落到该应用第一个 ACTIVE 数据源。
// 这样即使开发者只建了数据源却没显式点「设为默认」，甲方侧也不会被卡住。
export async function resolveDefaultDataSourceId(ctx: RoleContext): Promise<string | null> {
  const want = ctx.settings.defaultDs;
  if (want) {
    const row = await pGet<{ id: string }>(
      `SELECT id FROM data_source WHERE id=? AND app_id=? AND status='ACTIVE'`,
      [want, ctx.appId],
    );
    if (row) return row.id;
  }
  const rows = await pQuery<{ id: string }>(
    `SELECT id FROM data_source WHERE app_id=? AND status='ACTIVE' ORDER BY created_at LIMIT 1`,
    [ctx.appId],
  );
  return rows[0]?.id ?? null;
}

// 测试连接 + 只读校验（M0 验收：INSERT 必失败 → 返回 isReadonly=false）
export async function testDataSource(id: string): Promise<{ ok: boolean; isReadonly: boolean }> {
  const ds = await loadDataSource(id);
  const adapter = new MysqlAdapter(ds);
  try {
    await adapter.connect();
    const isReadonly = await adapter.testReadonly();
    return { ok: true, isReadonly };
  } catch (e) {
    return { ok: false, isReadonly: false };
  } finally {
    // 释放临时连接（池由缓存持有，这里仅探活）
    void getDsPool(ds);
  }
}

// 刷新元数据缓存（直接查 information_schema，绕过 SQL 网关——这是平台自理的只读查询）
export async function refreshCatalog(id: string): Promise<void> {
  const ds = await loadDataSource(id);
  const pool = getDsPool(ds);
  const conn = await pool.getConnection();
  try {
    // 注意：information_schema 的列名在 MySQL 中是大写（TABLE_NAME），必须用 AS 显式别名，
    // 否则 mysql2 返回的 RowDataPacket 键为大写，t.table_name 恒为 undefined。
    const [tables] = await conn.execute(
      `SELECT table_name AS table_name, table_comment AS table_comment
       FROM information_schema.tables WHERE table_schema=?`,
      [ds.database_name],
    );
    const catalog = [];
    for (const t of tables as any[]) {
      const [cols] = await conn.execute(
        `SELECT column_name AS column_name, column_type AS column_type, column_comment AS column_comment
         FROM information_schema.columns WHERE table_schema=? AND table_name=?
         ORDER BY ordinal_position`,
        [ds.database_name, t.table_name],
      );
      catalog.push({ table: t.table_name, comment: t.table_comment, columns: cols });
    }
    await pRun('UPDATE data_source SET catalog_json=? WHERE id=?', [JSON.stringify(catalog), id]);
  } finally {
    conn.release();
  }
}

export interface CatalogTable {
  table: string;
  comment?: string;
  columns: { column_name: string; column_type: string; column_comment?: string }[];
}
export async function getCatalog(ds: DataSourceRow): Promise<CatalogTable[]> {
  if (ds.catalog_json) {
    try {
      return JSON.parse(ds.catalog_json);
    } catch {
      /* fallthrough */
    }
  }
  await refreshCatalog(ds.id);
  const fresh = await loadDataSource(ds.id);
  return fresh.catalog_json ? JSON.parse(fresh.catalog_json) : [];
}

// ─────────────────────────────────────────────────────────────
// 数据库结构文档（数据字典）：表 / 字段 / 索引 / 外键 / 行数
// 直接查 information_schema（平台自理的只读查询），结果缓存到 data_source.schema_doc_json
// ─────────────────────────────────────────────────────────────

export interface SchemaDocColumn {
  name: string;
  type: string;          // 完整类型，如 varchar(200) / int unsigned
  nullable: boolean;     // 是否允许为空
  key: '' | 'PRI' | 'UNI' | 'MUL';
  defaultValue: string | null;
  extra: string;         // auto_increment / on update CURRENT_TIMESTAMP
  comment: string;
}
export interface SchemaDocIndex {
  name: string;
  columns: string[];
  unique: boolean;
}
export interface SchemaDocFk {
  constraint: string;
  column: string;
  refTable: string;
  refColumn: string;
}
export interface SchemaDocTable {
  name: string;
  comment: string;
  engine: string;
  rows: number;          // InnoDB 为估算值
  collation: string;
  createdAt: string | null;
  sizeBytes: number;     // 数据 + 索引
  columns: SchemaDocColumn[];
  indexes: SchemaDocIndex[];
  foreignKeys: SchemaDocFk[];
}
export interface SchemaDoc {
  dsId: string;
  dsName: string;
  database: string;
  generatedAt: string;
  tableCount: number;
  columnCount: number;
  tables: SchemaDocTable[];
}

function str(v: unknown): string {
  if (v == null) return '';
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  return String(v);
}

// 真正去业务库抓一次结构（4 条批量查询，不做 N+1）
export async function refreshSchemaDoc(id: string): Promise<SchemaDoc> {
  const ds = await loadDataSource(id);
  const pool = getDsPool(ds);
  const conn = await pool.getConnection();
  try {
    const [tRows] = await conn.execute(
      `SELECT table_name AS table_name, table_comment AS table_comment, engine AS engine,
              table_rows AS table_rows, table_collation AS table_collation,
              create_time AS create_time, data_length AS data_length, index_length AS index_length
       FROM information_schema.tables WHERE table_schema=? ORDER BY table_name`,
      [ds.database_name],
    );
    const [cRows] = await conn.execute(
      `SELECT table_name AS table_name, column_name AS column_name, column_type AS column_type,
              is_nullable AS is_nullable, column_key AS column_key,
              CAST(column_default AS CHAR) AS column_default, extra AS extra, column_comment AS column_comment
       FROM information_schema.columns WHERE table_schema=?
       ORDER BY table_name, ordinal_position`,
      [ds.database_name],
    );
    const [iRows] = await conn.execute(
      `SELECT table_name AS table_name, index_name AS index_name, column_name AS column_name,
              non_unique AS non_unique, seq_in_index AS seq_in_index
       FROM information_schema.statistics WHERE table_schema=?
       ORDER BY table_name, index_name, seq_in_index`,
      [ds.database_name],
    );
    const [fRows] = await conn.execute(
      `SELECT table_name AS table_name, column_name AS column_name, constraint_name AS constraint_name,
              referenced_table_name AS referenced_table_name, referenced_column_name AS referenced_column_name
       FROM information_schema.key_column_usage
       WHERE table_schema=? AND referenced_table_name IS NOT NULL
       ORDER BY table_name, constraint_name`,
      [ds.database_name],
    );

    const colsBy = new Map<string, SchemaDocColumn[]>();
    for (const c of cRows as any[]) {
      const t = str(c.table_name);
      if (!colsBy.has(t)) colsBy.set(t, []);
      colsBy.get(t)!.push({
        name: str(c.column_name),
        type: str(c.column_type),
        nullable: str(c.is_nullable).toUpperCase() === 'YES',
        key: (['PRI', 'UNI', 'MUL'].includes(str(c.column_key)) ? str(c.column_key) : '') as SchemaDocColumn['key'],
        defaultValue: c.column_default == null ? null : str(c.column_default),
        extra: str(c.extra),
        comment: str(c.column_comment),
      });
    }

    const idxBy = new Map<string, SchemaDocIndex[]>();
    for (const i of iRows as any[]) {
      const t = str(i.table_name);
      if (!idxBy.has(t)) idxBy.set(t, []);
      const list = idxBy.get(t)!;
      const name = str(i.index_name);
      let hit = list.find((x) => x.name === name);
      if (!hit) { hit = { name, columns: [], unique: Number(i.non_unique) === 0 }; list.push(hit); }
      hit.columns.push(str(i.column_name));
    }

    const fkBy = new Map<string, SchemaDocFk[]>();
    for (const f of fRows as any[]) {
      const t = str(f.table_name);
      if (!fkBy.has(t)) fkBy.set(t, []);
      fkBy.get(t)!.push({
        constraint: str(f.constraint_name),
        column: str(f.column_name),
        refTable: str(f.referenced_table_name),
        refColumn: str(f.referenced_column_name),
      });
    }

    const tables: SchemaDocTable[] = (tRows as any[]).map((t) => {
      const name = str(t.table_name);
      const dataLen = Number(t.data_length ?? 0);
      const idxLen = Number(t.index_length ?? 0);
      return {
        name,
        comment: str(t.table_comment),
        engine: str(t.engine),
        rows: Number(t.table_rows ?? 0),
        collation: str(t.table_collation),
        createdAt: t.create_time ? new Date(t.create_time).toISOString() : null,
        sizeBytes: dataLen + idxLen,
        columns: colsBy.get(name) ?? [],
        indexes: idxBy.get(name) ?? [],
        foreignKeys: fkBy.get(name) ?? [],
      };
    });

    const doc: SchemaDoc = {
      dsId: ds.id,
      dsName: ds.name,
      database: ds.database_name,
      generatedAt: new Date().toISOString(),
      tableCount: tables.length,
      columnCount: tables.reduce((n, t) => n + t.columns.length, 0),
      tables,
    };
    await pRun('UPDATE data_source SET schema_doc_json=?, schema_doc_at=NOW() WHERE id=?', [JSON.stringify(doc), id]);
    return doc;
  } finally {
    conn.release();
  }
}

// 读结构文档：有缓存直接用；没有或 force=true 就现场抓一次
export async function getSchemaDoc(id: string, force = false): Promise<SchemaDoc> {
  const ds = await loadDataSource(id);
  if (!force && ds.schema_doc_json) {
    try {
      return JSON.parse(ds.schema_doc_json) as SchemaDoc;
    } catch {
      /* 缓存坏了就重抓 */
    }
  }
  return refreshSchemaDoc(id);
}
