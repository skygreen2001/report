export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { setDefaultDataSource } from '@/server/services/datasource';
import { HttpError } from '@/server/errors';

// POST /data-sources/:id/default —— 设为该应用的默认数据源（仅 DEVELOPER）
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRole(req, async (ctx) => {
    if (ctx.role !== 'DEVELOPER') throw new HttpError(403, 'FORBIDDEN');
    const { id } = await params;
    await setDefaultDataSource(ctx, id);
    return json({ ok: true, defaultDs: id });
  });
}
