export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { completeRequirement, confirmRequirement } from '@/server/services/requirement';
import { z } from 'zod';

const ConfirmSchema = z.object({ confirm: z.boolean() });

// POST /requirements/{id}:complete —— 开发者标记完成（REQ-COL-04）
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRole(req, async (ctx) => {
    if (ctx.role === 'DEVELOPER') {
      await completeRequirement(ctx, id);
      return json({ ok: true });
    }
    // 甲方确认/驳回（REQ-COL-05/06）
    const body = ConfirmSchema.parse(await req.json());
    await confirmRequirement(ctx, id, body.confirm);
    return json({ ok: true });
  });
}
