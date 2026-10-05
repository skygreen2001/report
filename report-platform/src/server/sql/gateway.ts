// ★ 全项目唯一 SQL 执行入口（doc §1.1、§6.4、REQ-SEC-08、REQ-PARAM-07、ADR-13）。
// 五道闸：Parse → Validate → Rewrite → Execute → Shape。
import { parse, bindValues } from './parser';
import { validate } from './validator';
import { rewrite } from './rewriter';
import { withReadonlyConn } from './executor';
import { applyShape, parseSensitive } from './shape';
import { auditRun } from '../services/audit';
import { mapDbError } from '../errors';
import type { DataSourceRow, RoleContext, RunSource } from '@/lib/types';

export interface ExecuteOpt {
  maxRows: number;
  timeoutMs: number;
  source: RunSource;
  ctx: RoleContext;
  reportId?: string;
}

export interface ExecuteResult {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
}

// 只走前两道闸（Parse → Validate），不执行、不连业务库、不写运行审计。
// 用途：保存报表 / 更新 SQL 时前置校验，避免把非法 SQL 存进去，等甲方点开才报错（快速失败）。
export function validateOnly(rawSql: string, databaseName: string): { paramNames: string[] } {
  const { paramNames, ast } = parse(rawSql);
  validate(ast, rawSql, [databaseName]);
  return { paramNames };
}

export async function execute(
  ds: DataSourceRow,
  rawSql: string,
  params: Record<string, unknown>,
  opt: ExecuteOpt,
): Promise<ExecuteResult> {
  const started = Date.now();
  const sensitive = parseSensitive(ds.sensitive_columns_json);
  try {
    const { template, paramNames, ast } = parse(rawSql);
    validate(ast, rawSql, [ds.database_name]);
    const finalSql = rewrite(ast, opt.maxRows);
    const values = bindValues(paramNames, params);

    // fields 一并取回：0 行时也能给出表头，否则前端看到的是完全空白，
    // 用户分不清「查到 0 行」和「查询坏了」。
    const { rows, fields } = await withReadonlyConn(ds, opt.timeoutMs, async (conn) => {
      const [r, f] = await conn.execute(finalSql, values); // 真 prepared statement
      return { rows: r as Record<string, unknown>[], fields: (f ?? []) as { name: string }[] };
    });

    const shaped = applyShape(rows, sensitive);
    const columns = shaped[0] ? Object.keys(shaped[0]) : fields.map((f) => f.name);
    await auditRun(opt.ctx, {
      sql: finalSql,
      params,
      rows: rows.length,
      ms: Date.now() - started,
      result: 'SUCCESS',
      source: opt.source,
      reportId: opt.reportId,
      dataSourceId: ds.id,
    });

    return {
      columns,
      rows: shaped,
      truncated: false,
    };
  } catch (e) {
    const rejected = e instanceof Error && (e as any).name === 'SqlReject';
    // 表不存在/列名写错/无权限/超时 → 翻译成明确编号，走 400（用户可自行修正）
    const dbErr = mapDbError(e);
    const finalErr = dbErr ?? e;
    await auditRun(opt.ctx, {
      sql: rawSql,
      params,
      rows: 0,
      ms: Date.now() - started,
      result: rejected || dbErr ? 'REJECTED' : 'FAILED',
      source: opt.source,
      errorCode: (finalErr as any)?.code,
      reportId: opt.reportId,
      dataSourceId: ds.id,
    });
    throw finalErr;
  }
}

