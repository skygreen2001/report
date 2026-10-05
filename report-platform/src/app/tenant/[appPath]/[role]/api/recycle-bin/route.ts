export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { purge } from '@/server/services/lifecycle';
import { z } from 'zod';

const PurgeSchema = z.object({ ids: z.array(z.string()).min(1) });

// POST /recycle-bin —— 清空（甲方=不可见 / 开发者=物理删除，REQ-LIFE-06/10/11）
export async function POST(req: Request) {
  return withRole(req, async (ctx) => {
    const body = PurgeSchema.parse(await req.json());
    await purge(ctx, body.ids);
    return json({ ok: true });
  });
}
