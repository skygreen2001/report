export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { resolvePlatformRoot } from '@/server/context';
import { disableApplication } from '@/server/services/application';

// POST /applications/{id}/disable —— 停用应用（根应用拒绝，REQ-ACC-07/13）
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRole(req, async (ctx) => {
    await resolvePlatformRoot(req);
    await disableApplication(ctx, id);
    return json({ ok: true });
  });
}
