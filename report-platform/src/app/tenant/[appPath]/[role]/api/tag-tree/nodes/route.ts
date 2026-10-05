export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { deleteNode, renameNode } from '@/server/services/tagTree';
import { HttpError } from '@/server/errors';
import { z } from 'zod';

const DelSchema = z.object({ id: z.string(), mode: z.enum(['to_bin', 'to_parent']).default('to_bin') });
const RenameSchema = z.object({ id: z.string(), name: z.string().min(1) });

// DELETE /tag-tree/nodes?id=&mode= —— 删除目录（非空目录二选一，REQ-TAG-06）
export async function DELETE(req: Request) {
  return withRole(req, async (ctx) => {
    const url = new URL(req.url);
    const body = DelSchema.parse({ id: url.searchParams.get('id') ?? '', mode: (url.searchParams.get('mode') as any) ?? 'to_bin' });
    await deleteNode(ctx.appId, ctx.role, body.id, body.mode);
    return json({ ok: true });
  });
}

// PATCH /tag-tree/nodes —— 重命名（系统节点不可，REQ-TAG-03）
export async function PATCH(req: Request) {
  return withRole(req, async (ctx) => {
    const body = RenameSchema.parse(await req.json());
    await renameNode(ctx.appId, ctx.role, body.id, body.name);
    return json({ ok: true });
  });
}
