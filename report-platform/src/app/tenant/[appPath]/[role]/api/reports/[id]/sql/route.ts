export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { updateSql, getSqlVersions } from '@/server/services/report';
import { UpdateSqlSchema } from '@/server/schemas';
import { HttpError } from '@/server/errors';

// PUT /reports/{id}/sql —— 改 SQL（新增不可变版本，仅 DEVELOPER，REQ-COL-03、REQ-META-05）
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRole(req, async (ctx) => {
    if (ctx.role !== 'DEVELOPER') throw new HttpError(403, 'FORBIDDEN');
    const body = UpdateSqlSchema.parse(await req.json());
    await updateSql(ctx, id, body.sqlText, body.note ?? undefined);
    return json({ ok: true });
  });
}

// GET /reports/{id}/sql-versions —— SQL 版本历史（仅 DEVELOPER，REQ-META-03/06）
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRole(req, async (ctx) => {
    const versions = await getSqlVersions(ctx, id);
    return json({ versions });
  });
}
