export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { listProviders, createProvider } from '@/server/services/llm';
import { LlmProviderSchema } from '@/server/schemas';
import { HttpError } from '@/server/errors';

// GET /llm-providers —— 模型列表。按角色作用域隔离：开发者看自己的全量（含 endpoint/hasKey），甲方只看自己的可选模型名。
export async function GET(req: Request) {
  return withRole(req, async (ctx) => {
    const rows = await listProviders(ctx);
    if (ctx.role === 'CLIENT') {
      return json({ providers: rows.map((r) => ({ id: r.id, name: r.name, model: r.model, vendor: r.vendor, is_default: r.is_default, status: r.status })) });
    }
    return json({ providers: rows });
  });
}

// POST /llm-providers —— 新增模型（开发者 / 甲方各自建自己的，scope=ctx.role）
export async function POST(req: Request) {
  return withRole(req, async (ctx) => {
    const body = LlmProviderSchema.parse(await req.json());
    const id = await createProvider(ctx, {
      name: body.name,
      vendor: body.vendor ?? 'custom',
      endpoint: body.endpoint,
      model: body.model,
      apiKey: body.apiKey ?? null,
      isDefault: !!body.isDefault,
    });
    return json({ id }, 201);
  });
}
