// 数据源服务（doc §5、§17.3）。CREATE 时加密密码；LIST 不含凭据；TEST 校验只读。
import { pGet, pQuery, pRun, platformTx } from '../db/platform';
import { MysqlAdapter, makeTempPool } from '../db/datasource';
import crypto from 'node:crypto';
import { encrypt } from '../crypto';
import { getDsPool } from '../db/datasource';
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
