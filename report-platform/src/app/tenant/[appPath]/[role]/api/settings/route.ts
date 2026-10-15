export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { updateAppSettings } from '@/server/services/application';
import { HttpError } from '@/server/errors';

// PUT /settings —— 改应用级设置（仅 DEVELOPER；目前承载 clientCanViewSql：控制甲方是否可见当前生效 SQL）。
// 甲方不可改（这是开发者对外的可见性决策），否则会被一键关掉自己却看不到。
export async function PUT(req: Request) {
  return withRole(req, async (ctx) => {
    if (ctx.role !== 'DEVELOPER') throw new HttpError(403, 'FORBIDDEN');
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const patch: Record<string, unknown> = {};
    if (typeof body.clientCanViewSql === 'boolean') patch.clientCanViewSql = body.clientCanViewSql;
    if (Object.keys(patch).length === 0) throw new HttpError(400, 'NO_FIELDS');
    const settings = await updateAppSettings(ctx.appId, patch as any);
    return json({ ok: true, settings });
  });
}
