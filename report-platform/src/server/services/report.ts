// 报表服务（doc §5、§9、REQ-SAVE/REQ-LIFE）。双轨可见性 + 保存即两棵树同时出现（M3 验收）。
import { pGet, pQuery, pRun, platformTx } from '../db/platform';
import { getRoot } from './tagTree';
import { auditAction } from './audit';
import { validateOnly } from '../sql/gateway';
import { loadDataSource } from './datasource';
import { HttpError } from '../errors';
import crypto from 'node:crypto';
import type { ReportRow, RoleContext } from '@/lib/types';

// 本角色可见的报表（按双轨状态过滤，REQ-LIFE-07/12）。
// 开发者只能打开自己工作区产出的报表；甲方是汇总方，可打开任何工作区共享出来的报表。
export async function loadReportForRole(ctx: RoleContext, id: string): Promise<ReportRow> {
  const stateCol = ctx.role === 'DEVELOPER' ? 'developer_state' : 'client_state';
  const r = await pGet<ReportRow>(
    `SELECT * FROM report WHERE id=? AND app_id=? AND ${stateCol} != 'PURGED'${
      ctx.role === 'DEVELOPER' ? ' AND ws_id=?' : ''
    }`,
    ctx.role === 'DEVELOPER' ? [id, ctx.appId, ctx.wsId] : [id, ctx.appId],
  );
  if (!r) throw new HttpError(404, 'REPORT_NOT_FOUND');
  return r;
}

// 列表：开发者＝自己工作区的报表；甲方＝汇总所有工作区共享出来的报表。
export async function listReports(ctx: RoleContext): Promise<any[]> {
  const stateCol = ctx.role === 'DEVELOPER' ? 'developer_state' : 'client_state';
  if (ctx.role === 'DEVELOPER') {
    return pQuery(
      `SELECT r.id, r.name, r.data_source_id, rp.tag_node_id,
              r.client_state, r.developer_state, r.created_at
       FROM report r
       LEFT JOIN report_placement rp ON rp.report_id=r.id AND rp.role=?
       WHERE r.app_id=? AND r.ws_id=? AND r.${stateCol} != 'PURGED'
       ORDER BY r.created_at DESC`,
      [ctx.role, ctx.appId, ctx.wsId],
    );
  }
  return pQuery(
    `SELECT r.id, r.name, r.data_source_id, rp.tag_node_id,
            r.client_state, r.developer_state, r.created_at, r.ws_id, w.name AS ws_name
     FROM report r
     LEFT JOIN report_placement rp ON rp.report_id=r.id AND rp.role=?
     LEFT JOIN dev_workspace w ON w.id=r.ws_id
     WHERE r.app_id=? AND r.${stateCol} != 'PURGED'
     ORDER BY r.created_at DESC`,
    [ctx.role, ctx.appId],
  );
}

export interface SaveReportInput {
  name: string;
  sqlText: string;
  dataSourceId: string;
  paramsSchemaJson?: string | null;
  parentNodeId?: string | null; // 开发者保存时指定目录；甲方保存到各自根
}

// 保存为常用报表：同一事务内为两棵树各建一条 placement（REQ-SAVE-02、M3 验收）
export async function saveReport(ctx: RoleContext, input: SaveReportInput): Promise<string> {
  // 保存前先过网关前两道闸：非法 SQL（写操作/系统库/危险函数/多语句）当场拒，不入库
  const ds = await loadDataSource(input.dataSourceId);
  if (ds.app_id !== ctx.appId) throw new HttpError(403, 'FORBIDDEN');
  validateOnly(input.sqlText, ds.database_name);

  const id = crypto.randomUUID();
  await platformTx(async (tx) => {
    await tx.run(
      `INSERT INTO report (id,app_id,ws_id,name,sql_text,data_source_id,params_schema_json,created_by,client_state,developer_state)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, ctx.appId, ctx.wsId, input.name, input.sqlText, input.dataSourceId, input.paramsSchemaJson ?? null, ctx.clientKey, 'NORMAL', 'NORMAL'],
    );
    // 当前角色落指定目录（或根），另一角色落其根（两份 placement 同时出现，REQ-SAVE-02）
    // 开发者 → 落在自己工作区的目录树；甲方 → 落在甲方那棵树，另一条落在甲方自己的(OWNER)开发者树
    const wsOf = (role: 'CLIENT' | 'DEVELOPER') => (role === 'DEVELOPER' ? ctx.wsId : null);
    const myRoot = await getRoot(ctx.appId, ctx.role, wsOf(ctx.role));
    const otherRole = ctx.role === 'DEVELOPER' ? 'CLIENT' : 'DEVELOPER';
    const otherRoot = await getRoot(ctx.appId, otherRole, wsOf(otherRole));
    const myParent = input.parentNodeId ?? myRoot.id;
    await tx.run('INSERT INTO report_placement (report_id,role,tag_node_id,origin_parent_id) VALUES (?,?,?,?)', [id, ctx.role, myParent, myParent]);
    await tx.run('INSERT INTO report_placement (report_id,role,tag_node_id,origin_parent_id) VALUES (?,?,?,?)', [id, otherRole, otherRoot.id, otherRoot.id]);
    // 首个 SQL 版本（追加不可变，REQ-META-05）
    await tx.run('INSERT INTO sql_version (id,report_id,app_id,sql_text,note,created_by_role) VALUES (?,?,?,?,\'初始版本\',?)', [crypto.randomUUID(), id, ctx.appId, input.sqlText, ctx.role]);
    await tx.run('UPDATE report SET current_sql_version_id=(SELECT id FROM sql_version WHERE report_id=? ORDER BY created_at DESC LIMIT 1) WHERE id=?', [id, id]);
  });
  await auditAction(ctx, { action: 'SAVE_REPORT', targetType: 'report', targetId: id });
  return id;
}

export async function updateSql(ctx: RoleContext, id: string, sqlText: string, note?: string): Promise<void> {
  if (ctx.role !== 'DEVELOPER') throw new HttpError(403, 'FORBIDDEN'); // 仅开发者改 SQL
  await platformTx(async (tx) => {
    // 只能改自己工作区产出的报表（跨工作区一律 404）
    const r = await tx.get('SELECT * FROM report WHERE id=? AND app_id=? AND ws_id=?', [id, ctx.appId, ctx.wsId]);
    if (!r) throw new HttpError(404, 'REPORT_NOT_FOUND');
    // 改 SQL 同样先过前两道闸（REQ-SEC-01）
    const ds = await loadDataSource(r.data_source_id);
    validateOnly(sqlText, ds.database_name);
    await tx.run('INSERT INTO sql_version (id,report_id,app_id,sql_text,note,created_by_role) VALUES (?,?,?,?,?,?)', [crypto.randomUUID(), id, ctx.appId, sqlText, note ?? '', 'DEVELOPER']);
    const vid = (await tx.query('SELECT id FROM sql_version WHERE report_id=? ORDER BY created_at DESC LIMIT 1', [id]))[0].id;
    await tx.run('UPDATE report SET sql_text=?, current_sql_version_id=? WHERE id=?', [sqlText, vid, id]);
  });
  await auditAction(ctx, { action: 'UPDATE_SQL', targetType: 'report', targetId: id });
}

export async function getSqlVersions(ctx: RoleContext, id: string): Promise<any[]> {
  if (ctx.role !== 'DEVELOPER') throw new HttpError(403, 'FORBIDDEN');
  return pQuery('SELECT id,sql_text,note,created_by_role,created_at FROM sql_version WHERE report_id=? ORDER BY created_at DESC', [id]);
}
