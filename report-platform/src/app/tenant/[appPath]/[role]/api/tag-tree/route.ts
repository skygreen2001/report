export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { listNodes, createNode } from '@/server/services/tagTree';
import { HttpError } from '@/server/errors';
import { z } from 'zod';

const CreateNodeSchema = z.object({ name: z.string().min(1), parentId: z.string().nullable().optional() });

// 开发者操作落在自己工作区的那棵树上；甲方固定操作 ws_id 为 NULL 的那棵
function wsOf(ctx: { role: 'CLIENT' | 'DEVELOPER'; wsId: string }): string | null {
  return ctx.role === 'DEVELOPER' ? ctx.wsId : null;
}

// GET /tag-tree —— 本角色（本工作区）标签树（REQ-TAG-04）
export async function GET(req: Request) {
  return withRole(req, async (ctx) => json({ nodes: await listNodes(ctx.appId, ctx.role, wsOf(ctx)) }));
}

// POST /tag-tree —— 新建目录节点
export async function POST(req: Request) {
  return withRole(req, async (ctx) => {
    const body = CreateNodeSchema.parse(await req.json());
    const id = await createNode(ctx.appId, ctx.role, wsOf(ctx), body.name, body.parentId ?? null);
    return json({ id }, 201);
  });
}
