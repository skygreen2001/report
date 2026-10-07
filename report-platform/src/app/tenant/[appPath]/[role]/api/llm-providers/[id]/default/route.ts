export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { setDefaultProvider } from '@/server/services/llm';
import { HttpError } from '@/server/errors';

// POST /llm-providers/{id}/default —— 设为「本角色」默认模型（开发者 / 甲方各自有独立的默认）
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRole(req, async (ctx) => {
    await setDefaultProvider(ctx, id);
    return json({ ok: true });
  });
}
