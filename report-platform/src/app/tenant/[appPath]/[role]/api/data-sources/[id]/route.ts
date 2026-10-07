export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { deleteDataSource } from '@/server/services/datasource';
import { HttpError } from '@/server/errors';

// DELETE /data-sources/:id —— 删除数据源（仅 DEVELOPER）
// 可选 body: { targetDsId } —— 当数据源被引用时，先把它关联的报表/运行记录改派到该源再删除（合并重复）
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRole(req, async (ctx) => {
    if (ctx.role !== 'DEVELOPER') throw new HttpError(403, 'FORBIDDEN');
    let targetDsId: string | undefined;
    try {
      const b = await req.json().catch(() => null);
      if (b && typeof b.targetDsId === 'string' && b.targetDsId) targetDsId = b.targetDsId;
    } catch {
      /* 无 body 也可（直接删未被占用的源） */
    }
    const res = await deleteDataSource(ctx, id, targetDsId);
    return json({ ok: true, ...res });
  });
}
