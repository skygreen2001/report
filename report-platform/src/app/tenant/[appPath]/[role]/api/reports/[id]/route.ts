export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { loadReportForRole } from '@/server/services/report';
import { listForReport } from '@/server/services/requirement';
import { HttpError } from '@/server/errors';

// GET /reports/{id} —— 详情；currentSql 按 clientCanViewSql 决定（REQ-META-04/07、Q-02）
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRole(req, async (ctx) => {
    const r = await loadReportForRole(ctx, id);
    const canSeeSql = ctx.role === 'DEVELOPER' || ctx.settings.clientCanViewSql;
    const requirements = await listForReport(ctx, id);
    return json({
      id: r.id,
      name: r.name,
      dataSourceId: r.data_source_id,
      // 参数定义：甲方也要用它渲染 {{param}} 输入框（只是定义，不含数据）
      paramsSchemaJson: r.params_schema_json ?? null,
      currentSql: canSeeSql ? r.sql_text : undefined, // ★ 接口层裁掉，不是前端不渲染
      clientState: ctx.role === 'DEVELOPER' ? r.client_state : undefined,
      developerState: ctx.role === 'DEVELOPER' ? r.developer_state : undefined,
      // 甲方 PURGED 的报表在开发者视图带「甲方已不可见」徽标（REQ-LIFE-08）
      clientHidden: ctx.role === 'DEVELOPER' && r.client_state === 'PURGED',
      requirements,
    });
  });
}
