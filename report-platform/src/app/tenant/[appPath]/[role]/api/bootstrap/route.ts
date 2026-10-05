export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { listReports } from '@/server/services/report';
import { listNodes } from '@/server/services/tagTree';
import { listDataSources, resolveDefaultDataSourceId } from '@/server/services/datasource';

// GET /bootstrap —— 首屏一次拿全：应用信息 + 角色 + 标签树 + 报表列表（REQ-ACC-03/04）
export async function GET(req: Request) {
  return withRole(req, async (ctx) => {
    const [reports, nodes, ds] = await Promise.all([
      listReports(ctx),
      listNodes(ctx.appId, ctx.role),
      ctx.role === 'DEVELOPER' ? listDataSources(ctx.appId) : Promise.resolve([]),
    ]);
    // defaultDs 回落：settings 里没配（或已失效）时，用该应用第一个 ACTIVE 数据源
    const defaultDs = await resolveDefaultDataSourceId(ctx);
    return json({
      app: { id: ctx.appId, name: ctx.app.name, isPlatformRoot: !!ctx.app.is_platform_root },
      role: ctx.role,
      settings: { ...ctx.settings, defaultDs },
      reports,
      tagTree: nodes,
      dataSources: ds,
    });
  });
}
