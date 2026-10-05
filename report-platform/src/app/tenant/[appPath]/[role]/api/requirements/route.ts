export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { createRequirement, listInbox, listMine } from '@/server/services/requirement';
import { RequirementSchema } from '@/server/schemas';

// GET /requirements —— 甲方只见自己的；开发者见全部（REQ-META-02/03）
export async function GET(req: Request) {
  return withRole(req, async (ctx) => {
    const list = ctx.role === 'DEVELOPER' ? await listInbox(ctx) : await listMine(ctx);
    return json({ requirements: list });
  });
}

// POST /requirements —— 甲方求助开发者（REQ-COL-01）
export async function POST(req: Request) {
  return withRole(req, async (ctx) => {
    const body = RequirementSchema.parse(await req.json());
    const id = await createRequirement(ctx, body);
    return json({ id }, 201);
  });
}
