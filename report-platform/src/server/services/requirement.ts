// 协作需求服务（doc §10.5、REQ-COL-01~08）。需求状态机 OPEN→IN_PROGRESS→PENDING_CONFIRM→CONFIRMED。
import { pGet, pQuery, pRun, platformTx } from '../db/platform';
import { HttpError } from '../errors';
import crypto from 'node:crypto';
import type { RoleContext } from '@/lib/types';

export interface RequirementInput {
  prompt?: string | null;
  failedSql?: string | null;
  errorMsg?: string | null;
  clientNote?: string | null;
  reportId?: string | null;
}

// 甲方求助开发者（REQ-COL-01）
export async function createRequirement(ctx: RoleContext, input: RequirementInput): Promise<string> {
  const id = crypto.randomUUID();
  await pRun(
    `INSERT INTO requirement (id,app_id,report_id,status,prompt,failed_sql,error_msg,client_note,client_key,created_by_role)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, ctx.appId, input.reportId ?? null, 'OPEN', input.prompt ?? null, input.failedSql ?? null, input.errorMsg ?? null, input.clientNote ?? null, ctx.clientKey, ctx.role],
  );
  return id;
}

// 开发者收件箱：看全部（REQ-COL-07）
export async function listInbox(ctx: RoleContext): Promise<any[]> {
  if (ctx.role !== 'DEVELOPER') throw new HttpError(403, 'FORBIDDEN');
  return pQuery('SELECT * FROM requirement WHERE app_id=? ORDER BY created_at DESC', [ctx.appId]);
}

// 甲方只见自己提交的（REQ-META-02/03）
export async function listMine(ctx: RoleContext): Promise<any[]> {
  return pQuery('SELECT * FROM requirement WHERE app_id=? AND client_key=? ORDER BY created_at DESC', [ctx.appId, ctx.clientKey]);
}

export async function listForReport(ctx: RoleContext, reportId: string): Promise<any[]> {
  if (ctx.role === 'CLIENT') {
    return pQuery('SELECT * FROM requirement WHERE app_id=? AND report_id=? AND client_key=? ORDER BY created_at DESC', [ctx.appId, reportId, ctx.clientKey]);
  }
  return pQuery('SELECT * FROM requirement WHERE app_id=? AND report_id=? ORDER BY created_at DESC', [ctx.appId, reportId]);
}

// 开发者开始处理（REQ-COL-04）→ PENDING_CONFIRM
export async function completeRequirement(ctx: RoleContext, id: string): Promise<void> {
  if (ctx.role !== 'DEVELOPER') throw new HttpError(403, 'FORBIDDEN');
  await platformTx(async (tx) => {
    const r = await tx.get('SELECT * FROM requirement WHERE id=? AND app_id=?', [id, ctx.appId]);
    if (!r) throw new HttpError(404, 'REQ_NOT_FOUND');
    await tx.run("UPDATE requirement SET status='PENDING_CONFIRM', updated_at=NOW() WHERE id=?", [id]);
  });
}

// 甲方确认/驳回（REQ-COL-05/06）
export async function confirmRequirement(ctx: RoleContext, id: string, confirm: boolean): Promise<void> {
  if (ctx.role !== 'CLIENT') throw new HttpError(403, 'FORBIDDEN');
  await platformTx(async (tx) => {
    const r = await tx.get('SELECT * FROM requirement WHERE id=? AND app_id=? AND client_key=?', [id, ctx.appId, ctx.clientKey]);
    if (!r) throw new HttpError(404, 'REQ_NOT_FOUND');
    await tx.run('UPDATE requirement SET status=?, updated_at=NOW() WHERE id=?', [confirm ? 'CONFIRMED' : 'OPEN', id]);
  });
}
