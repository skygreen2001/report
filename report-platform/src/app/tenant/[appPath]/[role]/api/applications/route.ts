export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { resolvePlatformRoot } from '@/server/context';
import { createApplication, listApplications } from '@/server/services/application';
import { CreateAppSchema } from '@/server/schemas';

// POST /applications —— 创建应用并初始化两棵树（仅平台根应用，REQ-ACC-10/11）
export async function POST(req: Request) {
  return withRole(req, async (ctx) => {
    await resolvePlatformRoot(req); // 403 若非根应用/非开发者
    const body = CreateAppSchema.parse(await req.json());
    const id = await createApplication({ ...body, host: body.host ?? '' });
    return json({ id }, 201);
  });
}

// GET /applications —— 应用列表（仅平台根应用内）
export async function GET(req: Request) {
  return withRole(req, async (ctx) => {
    await resolvePlatformRoot(req);
    return json({ applications: await listApplications() });
  });
}
