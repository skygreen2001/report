export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { testDataSource } from '@/server/services/datasource';
import { HttpError } from '@/server/errors';

// POST /data-sources/{id}/test —— 测试连接 + 只读校验（REQ-DS-02/05）
// M0 验收：只读账号建的连接，INSERT 测试必失败 → isReadonly=false
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRole(req, async (ctx) => {
    if (ctx.role !== 'DEVELOPER') throw new HttpError(403, 'FORBIDDEN');
    const result = await testDataSource(id);
    return json(result);
  });
}
