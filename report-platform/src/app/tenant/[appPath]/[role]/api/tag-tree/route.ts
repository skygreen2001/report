export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { listNodes, createNode } from '@/server/services/tagTree';
import { HttpError } from '@/server/errors';
import { z } from 'zod';

const CreateNodeSchema = z.object({ name: z.string().min(1), parentId: z.string().nullable().optional() });

// GET /tag-tree —— 本角色标签树（REQ-TAG-04）
export async function GET(req: Request) {
  return withRole(req, async (ctx) => json({ nodes: await listNodes(ctx.appId, ctx.role) }));
}

// POST /tag-tree —— 新建目录节点
export async function POST(req: Request) {
  return withRole(req, async (ctx) => {
    const body = CreateNodeSchema.parse(await req.json());
    const id = await createNode(ctx.appId, ctx.role, body.name, body.parentId ?? null);
    return json({ id }, 201);
  });
}
