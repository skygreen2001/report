export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { rateLimit } from '@/server/ratelimit';
import { execute } from '@/server/sql/gateway';
import { loadDataSource, resolveDefaultDataSourceId, getSchemaDoc, buildColumnLabels } from '@/server/services/datasource';
import { loadReportForRole } from '@/server/services/report';
import { parseParamSchema, resolveParams } from '@/server/services/paramMap';
import { PreviewSchema } from '@/server/schemas';
import { HttpError } from '@/server/errors';

// POST /reports/preview —— 预览（≤200 行，走 SQL 网关，REQ-GEN-03/04）
export async function POST(req: Request) {
  return withRole(req, async (ctx) => {
    rateLimit(`prev:${ctx.appId}:${ctx.clientKey}`, 30, 60_000);
    const body = PreviewSchema.parse(await req.json());

    let sql = body.sql ?? undefined;
    let dsId = body.dataSourceId ?? undefined;
    let schemaJson: string | null | undefined;
    let reportId: string | undefined;

    if (body.reportId) {
      const r = await loadReportForRole(ctx, body.reportId);
      dsId = r.data_source_id ?? dsId;
      sql = r.sql_text;
      schemaJson = r.params_schema_json; // 报表已存的参数定义（含映射选项）
      reportId = r.id;
    } else {
      schemaJson = body.paramsSchemaJson; // 未保存的草稿：前端把当前编辑的定义一并带上
    }
    if (!dsId) dsId = (await resolveDefaultDataSourceId(ctx)) ?? undefined;
    if (!sql) throw new HttpError(400, 'NO_SQL'); // reportId / sql 至少给一个
    if (!dsId) throw new HttpError(400, 'NO_DATA_SOURCE');

    // 参数映射：甲方提交中文 label → 数据库 value（服务端权威，防伪造）
    const params = resolveParams(parseParamSchema(schemaJson), body.params);

    const ds = await loadDataSource(dsId);
    const { columns, rows } = await execute(ds, sql, params, {
      maxRows: 200,
      timeoutMs: ctx.settings.timeoutMs,
      source: 'PREVIEW',
      ctx,
      reportId,
    });
    // 列显示名：优先列注释第一行（结构文档有缓存；抓取失败不影响预览，回落列名）。
    // 只带回结果列中命中的映射，避免整库注释撑大响应。
    let columnLabels: Record<string, string> = {};
    try {
      const full = buildColumnLabels(await getSchemaDoc(ds.id));
      for (const c of columns) if (full[c]) columnLabels[c] = full[c];
    } catch { /* 结构文档不可用时静默回落 */ }
    return json({ columns, rows, columnLabels });
  });
}
