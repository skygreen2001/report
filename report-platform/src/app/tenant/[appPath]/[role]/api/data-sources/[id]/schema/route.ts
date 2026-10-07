export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { getSchemaDoc, refreshSchemaDoc } from '@/server/services/datasource';
import { HttpError } from '@/server/errors';
import { auditAction } from '@/server/services/audit';

// 结构文档属于「可读的数据字典」，甲乙方都可看；但仍必须属于当前应用，且只暴露结构不暴露数据
async function ensureOwn(req: Request, id: string, ctxAppId: string) {
  const { loadDataSource } = await import('@/server/services/datasource');
  const ds = await loadDataSource(id);
  if (ds.app_id !== ctxAppId) throw new HttpError(404, 'DATA_SOURCE_NOT_FOUND');
  return ds;
}

// GET /data-sources/{id}/schema?refresh=1 —— 数据库结构文档（数据字典）
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRole(req, async (ctx) => {
    await ensureOwn(req, id, ctx.appId);
    const force = new URL(req.url).searchParams.get('refresh') === '1';
    const doc = await getSchemaDoc(id, force);
    return json({ doc });
  });
}

// POST /data-sources/{id}/schema —— 强制重新抓取结构（结构变更后用）
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRole(req, async (ctx) => {
    const ds = await ensureOwn(req, id, ctx.appId);
    const doc = await refreshSchemaDoc(id);
    await auditAction(ctx, { action: 'SCHEMA_DOC_REFRESH', targetType: 'data_source', targetId: id, detail: { database: ds.database_name } });
    return json({ doc });
  });
}
