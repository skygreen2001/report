export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { listDataSources, createDataSource } from '@/server/services/datasource';
import { CreateDsSchema } from '@/server/schemas';
import { HttpError } from '@/server/errors';

// GET/POST /data-sources —— 列表（不含凭据）/ 新建（仅 DEVELOPER，REQ-DS-01/03）
export async function GET(req: Request) {
  return withRole(req, async (ctx) => {
    if (ctx.role !== 'DEVELOPER') throw new HttpError(403, 'FORBIDDEN');
    return json({ dataSources: await listDataSources(ctx.appId) });
  });
}

export async function POST(req: Request) {
  return withRole(req, async (ctx) => {
    if (ctx.role !== 'DEVELOPER') throw new HttpError(403, 'FORBIDDEN');
    const body = CreateDsSchema.parse(await req.json());
    const id = await createDataSource(ctx, body);
    return json({ id }, 201);
  });
}
