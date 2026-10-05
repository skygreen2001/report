// 审计服务（doc §17.5、REQ-SEC-12）。每次执行留痕 run_record，生命周期变更留痕 audit_log。
import { pRun } from '../db/platform';
import { randomTrace } from '../errors';
import type { RoleContext, RunSource } from '@/lib/types';

export interface RunAudit {
  sql: string;
  params: Record<string, unknown>;
  rows: number;
  ms: number;
  result: 'SUCCESS' | 'FAILED' | 'REJECTED';
  source: RunSource;
  errorCode?: string;
  reportId?: string;
  dataSourceId?: string;
}

// 执行留痕（含 REJECTED，M6 验收：审计表能查到每一次执行）
export async function auditRun(ctx: RoleContext, a: RunAudit): Promise<void> {
  try {
    await pRun(
      `INSERT INTO run_record
        (id, app_id, report_id, data_source_id, source, result, sql_text, params_json, row_count, ms, error_code, client_key, started_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
      [
        randomTrace(),
        ctx.appId,
        a.reportId ?? null,
        a.dataSourceId ?? null,
        a.source,
        a.result,
        // 审计只记模板与脱敏后参数值（REQ-PARAM-09 / §8.3）
        a.sql,
        JSON.stringify(a.params ?? {}),
        a.rows,
        a.ms,
        a.errorCode ?? null,
        ctx.clientKey,
      ],
    );
  } catch {
    // 审计失败不阻断主流程
  }
}

export interface ActionAudit {
  action: string;
  targetType?: string;
  targetId?: string;
  detail?: unknown;
}

export async function auditAction(ctx: RoleContext, a: ActionAudit): Promise<void> {
  try {
    await pRun(
      `INSERT INTO audit_log
        (id, app_id, actor_role, action, target_type, target_id, detail_json, client_key, started_at)
       VALUES (?,?,?,?,?,?,?,?,NOW())`,
      [
        randomTrace(),
        ctx.appId,
        ctx.role,
        a.action,
        a.targetType ?? null,
        a.targetId ?? null,
        a.detail != null ? JSON.stringify(a.detail) : null,
        ctx.clientKey,
      ],
    );
  } catch {
    /* noop */
  }
}
