export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { refreshCatalog, getCatalog } from '@/server/services/datasource';
import { HttpError } from '@/server/errors';

// POST /data-sources/{id}/catalog:refresh —— 刷新元数据（REQ-DS-04）
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRole(req, async (ctx) => {
    if (ctx.role !== 'DEVELOPER') throw new HttpError(403, 'FORBIDDEN');
    await refreshCatalog(id);
    return json({ ok: true });
  });
}

// GET /data-sources/{id}/catalog —— 读取元数据
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRole(req, async (ctx) => {
    if (ctx.role !== 'DEVELOPER') throw new HttpError(403, 'FORBIDDEN');
    const { loadDataSource } = await import('@/server/services/datasource');
    const ds = await loadDataSource(id);
    return json({ catalog: await getCatalog(ds) });
  });
}
