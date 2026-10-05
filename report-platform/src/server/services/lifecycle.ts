// 双轨生命周期服务（doc §7、REQ-LIFE-01~16）。两轨独立，唯一交汇点是开发者清空=物理删除。
import fs from 'fs';
import { pGet, platformTx } from '../db/platform';
import { getRoot, getRecycleBin } from './tagTree';
import { auditAction } from './audit';
import { HttpError } from '../errors';
import type { RoleContext } from '@/lib/types';

type Track = 'client' | 'developer';
const STATE_COL: Record<Track, string> = { client: 'client_state', developer: 'developer_state' };

export async function deleteReport(ctx: RoleContext, reportId: string): Promise<void> {
  const track = ctx.role === 'DEVELOPER' ? 'developer' : 'client';
  await platformTx(async (tx) => {
    const r = await tx.get('SELECT * FROM report WHERE id=? AND app_id=? FOR UPDATE', [reportId, ctx.appId]);
    if (!r) throw new HttpError(404, 'REPORT_NOT_FOUND');
    if (r[STATE_COL[track]] !== 'NORMAL') return; // 幂等（REQ-LIFE-02/09）

    const bin = await getRecycleBin(ctx.appId, ctx.role);
    const pl = await tx.get('SELECT * FROM report_placement WHERE report_id=? AND role=?', [reportId, ctx.role]);

    await tx.run(`UPDATE report SET ${STATE_COL[track]}='RECYCLED', ${track}_recycled_at=NOW() WHERE id=?`, [reportId]);
    await tx.run(
      'UPDATE report_placement SET tag_node_id=?, origin_parent_id=?, recycled_at=NOW() WHERE report_id=? AND role=?',
      [bin.id, pl?.tag_node_id ?? null, reportId, ctx.role],
    );
    await auditAction(ctx, { action: 'DELETE', targetType: 'report', targetId: reportId });
  });
}

export async function restoreReport(ctx: RoleContext, reportId: string): Promise<void> {
  const track = ctx.role === 'DEVELOPER' ? 'developer' : 'client';
  await platformTx(async (tx) => {
    const r = await tx.get('SELECT * FROM report WHERE id=? AND app_id=? FOR UPDATE', [reportId, ctx.appId]);
    if (!r) throw new HttpError(404, 'REPORT_NOT_FOUND');
    if (r[STATE_COL[track]] !== 'RECYCLED') throw new HttpError(409, 'NOT_IN_RECYCLE_BIN');

    // origin_parent_id 记在 report_placement 上（不是 report 上）——取错表会静默回落根目录
    const pl = await tx.get('SELECT origin_parent_id FROM report_placement WHERE report_id=? AND role=?', [reportId, ctx.role]);
    let target = pl?.origin_parent_id ?? null;
    if (target && !(await nodeExists(tx, target, ctx.role))) {
      target = (await getRoot(ctx.appId, ctx.role)).id; // 原父已删 → 落根（REQ-LIFE-04/05）
    }
    await tx.run(`UPDATE report SET ${STATE_COL[track]}='NORMAL' WHERE id=?`, [reportId]);
    await tx.run('UPDATE report_placement SET tag_node_id=?, origin_parent_id=NULL, recycled_at=NULL WHERE report_id=? AND role=?', [target, reportId, ctx.role]);
    await auditAction(ctx, { action: 'RESTORE', targetType: 'report', targetId: reportId });
  });
}

export async function purge(ctx: RoleContext, ids: string[]): Promise<void> {
  const track = ctx.role === 'DEVELOPER' ? 'developer' : 'client';
  await platformTx(async (tx) => {
    for (const id of ids) {
      const r = await tx.get('SELECT * FROM report WHERE id=? AND app_id=? FOR UPDATE', [id, ctx.appId]);
      if (!r) continue;
      if (track === 'developer') {
        const grace = ctx.settings.purgeGraceDays; // 默认 7，可配 0~30（REQ-LIFE-10/15）
        if (grace > 0) {
          await tx.run(`UPDATE report SET developer_state='PURGED', purge_due_at=DATE_ADD(NOW(), INTERVAL ? DAY) WHERE id=?`, [grace, id]);
        } else {
          await hardDelete(tx, ctx, id);
        }
      } else {
        // 甲方清空 = 仅甲方不可见，开发者仍可见（REQ-LIFE-06/07/08）
        await tx.run("UPDATE report SET client_state='PURGED', client_purged_at=NOW() WHERE id=?", [id]);
      }
      await auditAction(ctx, { action: 'PURGE', targetType: 'report', targetId: id });
    }
  });
}

// 开发者恢复甲方可见：甲方 PURGED → 落入甲方回收站（REQ-LIFE-16、Q-05）
export async function restoreClientVisibility(ctx: RoleContext, reportId: string): Promise<void> {
  if (ctx.role !== 'DEVELOPER') throw new HttpError(403, 'FORBIDDEN');
  await platformTx(async (tx) => {
    const r = await tx.get('SELECT * FROM report WHERE id=? AND app_id=? FOR UPDATE', [reportId, ctx.appId]);
    if (!r) throw new HttpError(404, 'REPORT_NOT_FOUND');
    if (r.client_state !== 'PURGED') throw new HttpError(409, 'CLIENT_NOT_PURGED');
    const bin = await getRecycleBin(ctx.appId, 'CLIENT');
    await tx.run("UPDATE report SET client_state='RECYCLED', client_recycled_at=NOW() WHERE id=?", [reportId]);
    await tx.run('UPDATE report_placement SET tag_node_id=?, recycled_at=NOW() WHERE report_id=? AND role=?', [bin.id, reportId, 'CLIENT']);
  });
}

// 物理删除：级联顺序子表→父表（REQ-LIFE-10/14）
async function hardDelete(tx: any, ctx: RoleContext, id: string): Promise<void> {
  // ① 先取导出文件清单再删行，否则 DELETE 之后就查不到 file_key 了（REQ-LIFE-10）
  const files = (await tx.query('SELECT file_key FROM export_task WHERE report_id=?', [id])) as { file_key: string | null }[];
  await tx.run('UPDATE report SET current_sql_version_id=NULL WHERE id=?', [id]);
  await tx.run('DELETE FROM report_placement WHERE report_id=?', [id]);
  await tx.run('DELETE FROM requirement WHERE report_id=?', [id]);
  await tx.run('DELETE FROM sql_version WHERE report_id=?', [id]);
  await tx.run('DELETE FROM export_task WHERE report_id=?', [id]);
  await tx.run('DELETE FROM run_record WHERE report_id=?', [id]);
  await tx.run('DELETE FROM report WHERE id=? AND app_id=?', [id, ctx.appId]);
  // ② 事务提交后再删磁盘文件，失败不影响数据一致性
  for (const f of files) {
    if (f.file_key) {
      try {
        fs.rmSync(f.file_key, { force: true });
      } catch {
        /* noop */
      }
    }
  }
}

async function nodeExists(tx: any, nodeId: string, role: 'CLIENT' | 'DEVELOPER'): Promise<boolean> {
  const n = await tx.get('SELECT id FROM tag_node WHERE id=? AND role=?', [nodeId, role]);
  return !!n;
}
