export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { rateLimit } from '@/server/ratelimit';
import { generateSql } from '@/server/services/generation';
import { resolveDefaultDataSourceId } from '@/server/services/datasource';
import { GenerateSchema } from '@/server/schemas';
import { HttpError } from '@/server/errors';

// POST /reports/generate —— 提示词 → 候选 SQL（不执行，REQ-GEN-01/02）
export async function POST(req: Request) {
  return withRole(req, async (ctx) => {
    rateLimit(`gen:${ctx.appId}:${ctx.clientKey}`, 30, 60_000);
    const body = GenerateSchema.parse(await req.json());
    const dataSourceId = body.dataSourceId ?? (await resolveDefaultDataSourceId(ctx)) ?? undefined;
    if (!dataSourceId) throw new HttpError(400, 'NO_DATA_SOURCE');
    const result = await generateSql(ctx, {
      prompt: body.prompt,
      dataSourceId: dataSourceId,
      dataSourceIds: body.dataSourceIds ?? undefined,
      currentSql: body.currentSql ?? undefined,
      providerId: body.providerId ?? undefined,
    }, {
      // taskId 供「停止生成」端点中断本次模型调用；客户端断开时也自动中断
      taskId: body.taskId ?? undefined,
      requestSignal: req.signal,
    });
    return json(result);
  });
}
