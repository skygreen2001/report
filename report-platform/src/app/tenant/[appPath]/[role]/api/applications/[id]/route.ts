export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { deleteApplication } from '@/server/services/application';

// DELETE /applications/{id} —— 删除应用并级联清理其全部数据（仅平台根应用）
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRole(req, async (ctx) => {
    await deleteApplication(ctx, id);
    return json({ ok: true });
  });
}
