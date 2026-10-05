export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { rateLimit } from '@/server/ratelimit';
import { execute } from '@/server/sql/gateway';
import { loadDataSource, resolveDefaultDataSourceId } from '@/server/services/datasource';
import { loadReportForRole } from '@/server/services/report';
import { PreviewSchema } from '@/server/schemas';
import { HttpError } from '@/server/errors';

// POST /reports/preview —— 预览（≤200 行，走 SQL 网关，REQ-GEN-03/04）
export async function POST(req: Request) {
  return withRole(req, async (ctx) => {
    rateLimit(`prev:${ctx.appId}:${ctx.clientKey}`, 30, 60_000);
    const body = PreviewSchema.parse(await req.json());

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
    const { columns, rows } = await execute(ds, sql, body.params, {
      maxRows: 200,
      timeoutMs: ctx.settings.timeoutMs,
      source: 'PREVIEW',
      ctx,
      reportId,
    });
    return json({ columns, rows });
  });
}
