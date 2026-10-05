export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { listReports, saveReport } from '@/server/services/report';
import { resolveDefaultDataSourceId } from '@/server/services/datasource';
import { SaveReportSchema } from '@/server/schemas';
import { HttpError } from '@/server/errors';

// GET /reports —— 列表（按本角色轨过滤，REQ-LIFE-07/12）
export async function GET(req: Request) {
  return withRole(req, async (ctx) => {
    return json({ reports: await listReports(ctx) });
  });
}

// POST /reports —— 保存为常用报表（REQ-SAVE-01/02/06）
export async function POST(req: Request) {
  return withRole(req, async (ctx) => {
    const body = SaveReportSchema.parse(await req.json());
    const dataSourceId = body.dataSourceId ?? (await resolveDefaultDataSourceId(ctx)) ?? undefined;
    if (!dataSourceId) throw new HttpError(400, 'NO_DATA_SOURCE');
    const id = await saveReport(ctx, { ...body, dataSourceId });
    return json({ id }, 201);
  });
}
