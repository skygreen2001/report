export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { testProvider, getProviderRow } from '@/server/services/llm';
import { HttpError } from '@/server/errors';

// POST /llm-providers/{id}/test —— 连通性测试（只能测自己作用域内的模型）
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRole(req, async (ctx) => {
    const row = await getProviderRow(ctx.appId, id, ctx.role); // 跨作用域 404
    // 允许带一个临时 key 先试（还没保存到库就想验证）
    let tmpKey: string | undefined;
    try {
      const b = await req.json();
      if (b && typeof b.apiKey === 'string' && b.apiKey) tmpKey = b.apiKey;
    } catch { /* 无 body 也允许 */ }
    return json(await testProvider(row, tmpKey));
  });
}
