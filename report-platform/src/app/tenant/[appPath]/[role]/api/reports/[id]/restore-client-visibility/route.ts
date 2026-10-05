export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { restoreClientVisibility } from '@/server/services/lifecycle';

// POST /reports/{id}:restore-client-visibility —— 开发者恢复甲方可见（REQ-LIFE-16、Q-05）
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRole(req, async (ctx) => {
    await restoreClientVisibility(ctx, id);
    return json({ ok: true });
  });
}
