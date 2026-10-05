export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { restoreReport } from '@/server/services/lifecycle';

// POST /reports/{id}:restore —— 还原（原父失效落根，REQ-LIFE-04/05）
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRole(req, async (ctx) => {
    await restoreReport(ctx, id);
    return json({ ok: true });
  });
}
