export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { StopGenerateSchema } from '@/server/schemas';
import { stopGenTask } from '@/server/services/generation';
import { HttpError } from '@/server/errors';

// POST /reports/generate/cancel —— 真正中断这次生成的模型调用（终止到模型的 HTTP 请求，省算力）
// 只停「本应用 + 本角色」发起的任务（stopGenTask 内校验归属），返回 stopped=false 表示任务已结束或不属于你
export async function POST(req: Request) {
  return withRole(req, async (ctx) => {
    const body = StopGenerateSchema.parse(await req.json().catch(() => ({})));
    if (!body.taskId) throw new HttpError(400, 'TASK_ID_REQUIRED');
    const stopped = stopGenTask(body.taskId, ctx);
    return json({ stopped });
  });
}
