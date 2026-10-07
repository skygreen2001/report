export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { resolvePlatformRoot } from '@/server/context';
import { enableApplication } from '@/server/services/application';

// POST /applications/{id}/enable —— 重新启用应用（仅平台根）
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRole(req, async (ctx) => {
    await resolvePlatformRoot(req);
    await enableApplication(ctx, id);
    return json({ ok: true });
  });
}
