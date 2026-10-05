export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { pRun, platformTx } from '@/server/db/platform';
import { HttpError } from '@/server/errors';
import { z } from 'zod';

const MoveSchema = z.object({ tagNodeId: z.string() });

// POST /reports/{id}:move —— 移动（仅影响本角色树，REQ-TAG-05、DP-02）
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRole(req, async (ctx) => {
    const body = MoveSchema.parse(await req.json());
    const exists = await pRun(
      'UPDATE report_placement SET tag_node_id=? WHERE report_id=? AND role=? AND (SELECT 1 FROM report WHERE id=? AND app_id=?) IS NOT NULL',
      [body.tagNodeId, id, ctx.role, id, ctx.appId],
    );
    if ((exists as any).affectedRows === 0) throw new HttpError(404, 'REPORT_NOT_FOUND');
    return json({ ok: true });
  });
}
