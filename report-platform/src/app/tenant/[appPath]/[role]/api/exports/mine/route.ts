export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { listMine } from '@/server/services/export';

// GET /exports/mine —— 我的导出历史（30 天，REQ-EXP-08、Q-09）
export async function GET(req: Request) {
  return withRole(req, async (ctx) => {
    const list = await listMine(ctx);
    return json({ exports: list });
  });
}
