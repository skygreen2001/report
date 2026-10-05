export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { deleteReport } from '@/server/services/lifecycle';

// POST /reports/{id}:delete —— 移入本角色回收站（REQ-LIFE-02/09）
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRole(req, async (ctx) => {
    await deleteReport(ctx, id);
    return json({ ok: true });
  });
}
