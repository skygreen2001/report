export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { updateProvider, deleteProvider } from '@/server/services/llm';
import { LlmProviderSchema } from '@/server/schemas';
import { HttpError } from '@/server/errors';

// PUT /llm-providers/{id} —— 改配置 / 启停（只能改自己作用域内的模型；apiKey 留空表示不改动）
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRole(req, async (ctx) => {
    const body = LlmProviderSchema.partial().parse(await req.json());
    await updateProvider(ctx, id, {
      name: body.name ?? undefined,
      vendor: body.vendor ?? undefined,
      endpoint: body.endpoint ?? undefined,
      model: body.model ?? undefined,
      apiKey: body.apiKey ?? undefined,
      isDefault: body.isDefault ?? undefined,
      status: body.status ?? undefined,
    });
    return json({ ok: true });
  });
}

// DELETE /llm-providers/{id} —— 删除（只能删自己作用域内的模型）
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRole(req, async (ctx) => {
    await deleteProvider(ctx, id);
    return json({ ok: true });
  });
}
