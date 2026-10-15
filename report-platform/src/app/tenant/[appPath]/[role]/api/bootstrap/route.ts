export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { listReports } from '@/server/services/report';
import { listNodes } from '@/server/services/tagTree';
import { listDataSources, resolveDefaultDataSourceId } from '@/server/services/datasource';
import { listProviders } from '@/server/services/llm';

// GET /bootstrap —— 首屏一次拿全：应用信息 + 角色 + 标签树 + 报表列表（REQ-ACC-03/04）
export async function GET(req: Request) {
  return withRole(req, async (ctx) => {
    const [reports, nodes, dsRows, providers] = await Promise.all([
      listReports(ctx),
      listNodes(ctx.appId, ctx.role, ctx.role === 'DEVELOPER' ? ctx.wsId : null),
      listDataSources(ctx),
      listProviders(ctx),
    ]);
    // 甲方也要看「数据库结构文档」，但只给库名与显示名，不给 host/账号等连接信息
    const ds = ctx.role === 'CLIENT'
      ? dsRows.map((d) => ({ id: d.id, name: d.name, database_name: d.database_name, status: d.status }))
      : dsRows;
    // defaultDs 回落：settings 里没配（或已失效）时，用该应用第一个 ACTIVE 数据源
    const defaultDs = await resolveDefaultDataSourceId(ctx);
    return json({
      app: { id: ctx.appId, name: ctx.app.name, isPlatformRoot: !!ctx.app.is_platform_root },
      role: ctx.role,
      // 当前访问者所处的「开发者工作区」。ws_key 就是他的身份（capability URL 的凭据），
      // 只回给本人：换设备时用 /{appPath}/d?ws=<wsKey> 即可把这套配置搬过去。
      workspace: { id: ctx.wsId, wsKey: ctx.wsKey },
      settings: { ...ctx.settings, defaultDs },
      reports,
      tagTree: nodes,
      dataSources: ds,
      // 甲方拿自己作用域的模型列表（用于「生成报表」下拉与「模型配置」页）；endpoint/密钥不下发
      llmProviders: ctx.role === 'CLIENT'
        ? providers.map((p) => ({ id: p.id, name: p.name, model: p.model, vendor: p.vendor, is_default: p.is_default, status: p.status }))
        : providers,
    });
  });
}
