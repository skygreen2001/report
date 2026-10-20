export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { rateLimit } from '@/server/ratelimit';
import { parse, bindValues } from '@/server/sql/parser';
import { validate } from '@/server/sql/validator';
import { rewriteBase } from '@/server/sql/rewriter';
import { withReadonlyConn } from '@/server/sql/executor';
import { applyShape, parseSensitive } from '@/server/sql/shape';
import { auditRun } from '@/server/services/audit';
import { mapDbError } from '@/server/errors';
import { loadDataSource, resolveDefaultDataSourceId, getSchemaDoc, buildColumnLabels } from '@/server/services/datasource';
import { loadReportForRole } from '@/server/services/report';
import { AllSchema } from '@/server/schemas';
import { HttpError } from '@/server/errors';

// POST /reports/all —— 「全部」分页查看：移除原 SQL 的 LIMIT 后包一层派生表，
// 先 COUNT 拿总数，再按 page/pageSize 取当前页。审计 source 记 PREVIEW（交互式查看）。
export async function POST(req: Request) {
  return withRole(req, async (ctx) => {
    rateLimit(`all:${ctx.appId}:${ctx.clientKey}`, 30, 60_000);
    const body = AllSchema.parse(await req.json());

    let sql = body.sql ?? undefined;
    let dsId = body.dataSourceId ?? undefined;
    let reportId: string | undefined;

    if (body.reportId) {
      const r = await loadReportForRole(ctx, body.reportId);
      dsId = r.data_source_id ?? dsId;
      sql = r.sql_text;
      reportId = r.id;
    }
    if (!dsId) dsId = (await resolveDefaultDataSourceId(ctx)) ?? undefined;
    if (!sql) throw new HttpError(400, 'NO_SQL'); // reportId / sql 至少给一个
    if (!dsId) throw new HttpError(400, 'NO_DATA_SOURCE');

    const ds = await loadDataSource(dsId);
    const page = body.page ?? 1;
    const pageSize = body.pageSize ?? 50;
    const offset = (page - 1) * pageSize;
    const started = Date.now();
    const sensitive = parseSensitive(ds.sensitive_columns_json);

    try {
      const { paramNames, ast } = parse(sql);
      validate(ast, sql, [ds.database_name]);
      // 移除 LIMIT（导出基线），末尾分号一并去掉，避免破坏外层派生表
      const baseSql = rewriteBase(ast).replace(/;\s*$/, '');
      const values = bindValues(paramNames, body.params);

      const { columns, rows, total } = await withReadonlyConn(ds, ctx.settings.timeoutMs, async (conn) => {
        // 总数：包一层派生表 COUNT，不受原 SQL 的 LIMIT 影响
        const [cntRows] = await conn.execute(`SELECT COUNT(*) AS _cnt FROM (${baseSql}) AS _c`, values);
        const total = Number((cntRows as any[])[0]?._cnt ?? 0);
        // 当前页：外层 LIMIT/OFFSET 为代码生成的整数，安全；0 行时 fields 仍能给表头
        const [pageRows, fields] = await conn.execute(
          `SELECT * FROM (${baseSql}) AS _p LIMIT ${pageSize} OFFSET ${offset}`,
          values,
        );
        const shaped = applyShape(pageRows as Record<string, unknown>[], sensitive);
        const columns = shaped[0]
          ? Object.keys(shaped[0])
          : ((fields ?? []) as { name: string }[]).map((f) => f.name);
        return { columns, rows: shaped, total };
      });

      await auditRun(ctx, {
        sql: baseSql,
        params: body.params,
        rows: rows.length,
        ms: Date.now() - started,
        result: 'SUCCESS',
        source: 'PREVIEW',
        reportId,
        dataSourceId: ds.id,
      });

      // 列显示名：优先列注释第一行（结构文档有缓存；抓取失败不影响查询，回落列名）。
      // 只带回结果列中命中的映射，避免整库注释撑大响应。
      let columnLabels: Record<string, string> = {};
      try {
        const full = buildColumnLabels(await getSchemaDoc(ds.id));
        for (const c of columns) if (full[c]) columnLabels[c] = full[c];
      } catch { /* 结构文档不可用时静默回落 */ }

      return json({ columns, rows, total, page, pageSize, columnLabels });
    } catch (e) {
      const rejected = e instanceof Error && (e as any).name === 'SqlReject';
      // 表不存在/列名写错/无权限/超时 → 翻译成明确编号，走 400（用户可自行修正）
      const dbErr = mapDbError(e);
      const finalErr = dbErr ?? e;
      await auditRun(ctx, {
        sql,
        params: body.params,
        rows: 0,
        ms: Date.now() - started,
        result: rejected || dbErr ? 'REJECTED' : 'FAILED',
        source: 'PREVIEW',
        errorCode: (finalErr as any)?.code,
        reportId,
        dataSourceId: ds.id,
      });
      throw finalErr;
    }
  });
}
