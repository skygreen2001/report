export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { rateLimit } from '@/server/ratelimit';
import { createExport } from '@/server/services/export';
import { resolveDefaultDataSourceId } from '@/server/services/datasource';
import { loadReportForRole } from '@/server/services/report';
import { parseParamSchema, resolveParams } from '@/server/services/paramMap';
import { ExportSchema } from '@/server/schemas';
import { HttpError } from '@/server/errors';

// POST /exports —— 发起导出（REQ-EXP-01/02）
export async function POST(req: Request) {
  return withRole(req, async (ctx) => {
    rateLimit(`exp:${ctx.appId}:${ctx.clientKey}`, 20, 60_000);
    const body = ExportSchema.parse(await req.json());

    // reportId / sql 二选一：给了 reportId 就导报表当前 SQL
    let sql = body.sql ?? undefined;
    let dsId = body.dataSourceId ?? undefined;
    let schemaJson: string | null | undefined;
    if (body.reportId) {
      const r = await loadReportForRole(ctx, body.reportId);
      sql = r.sql_text;
      dsId = r.data_source_id ?? dsId;
      schemaJson = r.params_schema_json;
    } else {
      schemaJson = body.paramsSchemaJson;
    }
    if (!dsId) dsId = (await resolveDefaultDataSourceId(ctx)) ?? undefined;
    if (!sql) throw new HttpError(400, 'NO_SQL');
    if (!dsId) throw new HttpError(400, 'NO_DATA_SOURCE');

    // 参数映射在此完成并落库：后台任务直接按映射后的值执行（防伪造）
    const params = resolveParams(parseParamSchema(schemaJson), body.params);

    const { id } = await createExport(ctx, {
      reportId: body.reportId ?? undefined,
      sql,
      params,
      format: body.format,
      dataSourceId: dsId,
    });
    return json({ id });
  });
}
