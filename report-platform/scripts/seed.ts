// 本地种子数据（npx tsx scripts/seed.ts，或 npm run seed）。
// 平台元库已是 SQLite 单文件：首次启动会自动建表并建平台根应用，这里补充示例应用与示例报表。
import crypto from 'node:crypto';
import { pGet, pRun, initPlatformDb } from '../src/server/db/platform';
import { ensurePlatformRoot, createApplication } from '../src/server/services/application';
import { ensureDefaultWorkspace } from '../src/server/services/devWorkspace';
import { encrypt } from '../src/server/crypto';

const uuid = () => crypto.randomUUID();

function settingsJson(defaultDs: string | null): string {
  return JSON.stringify({
    clientCanViewSql: true,
    maxRows: Number(process.env.DEFAULT_MAX_ROWS ?? 200),
    timeoutMs: Number(process.env.DEFAULT_TIMEOUT_MS ?? 15000),
    exportFileTtlHours: 24,
    purgeGraceDays: 7,
    embedMode: false,
    llm: { endpoint: process.env.LLM_BASE_URL ?? '', model: process.env.LLM_MODEL ?? 'deepseek-chat' },
    defaultDs,
  });
}

const DEMO_SQL =
  'SELECT region, COUNT(*) AS cnt, SUM(amount) AS total_amount FROM orders GROUP BY region ORDER BY total_amount DESC';

async function main() {
  await initPlatformDb();
  const rootId = await ensurePlatformRoot();
  console.log('平台根应用:', rootId);

  // 示例应用
  let demo = await pGet<{ id: string }>("SELECT id FROM application WHERE path_prefix='demo'");
  if (!demo) {
    const id = await createApplication({ name: '示例报表应用', pathPrefix: 'demo' });
    demo = { id };
    console.log('示例应用已创建:', id);
  } else {
    console.log('示例应用已存在:', demo.id);
  }
  const demoId = demo.id;
  await ensureDefaultWorkspace(demoId);

  // 数据源（只读账号，AES 加密）。没配 BIZ_DB_* 就跳过——部署环境通常连不到外部业务库。
  let dsId: string | null = null;
  const existingDs = await pGet<{ id: string }>('SELECT id FROM data_source WHERE app_id=? LIMIT 1', [demoId]);
  if (existingDs) {
    dsId = existingDs.id;
    console.log('数据源已存在:', dsId);
  } else if (process.env.BIZ_DB_HOST) {
    dsId = uuid();
    await pRun(
      `INSERT INTO data_source (id,app_id,name,host,port,database_name,username,password_enc,status)
       VALUES (?,?,?,?,?,?,?,?, 'ACTIVE')`,
      [
        dsId,
        demoId,
        '业务只读库',
        process.env.BIZ_DB_HOST,
        Number(process.env.BIZ_DB_PORT ?? 3306),
        process.env.BIZ_DB_NAME ?? 'biz_demo',
        process.env.BIZ_DB_USER ?? 'report_ro',
        encrypt(process.env.BIZ_DB_PASSWORD ?? ''),
      ],
    );
    console.log('数据源已创建:', dsId);
  } else {
    console.log('未配置 BIZ_DB_HOST，跳过数据源初始化');
  }

  // 示例报表（双轨各一条 placement + 初始 SQL 版本）
  const existingReport = await pGet<{ id: string }>('SELECT id FROM report WHERE app_id=? AND name=?', [demoId, '各地区订单汇总']);
  if (!existingReport) {
    if (!dsId) {
      console.log('没有可用数据源，跳过示例报表');
    } else {
      const rid = uuid();
      await pRun(
        `INSERT INTO report (id,app_id,name,sql_text,data_source_id,client_state,developer_state)
         VALUES (?,?,?,?,?, 'NORMAL', 'NORMAL')`,
        [rid, demoId, '各地区订单汇总', DEMO_SQL, dsId],
      );
      const vid = uuid();
      await pRun(
        `INSERT INTO sql_version (id,report_id,app_id,sql_text,note,created_by_role)
         VALUES (?,?,?,?, '初始版本', 'DEVELOPER')`,
        [vid, rid, demoId, DEMO_SQL],
      );
      await pRun('UPDATE report SET current_sql_version_id=? WHERE id=?', [vid, rid]);
      for (const role of ['CLIENT', 'DEVELOPER'] as const) {
        const root = await pGet<{ id: string }>(
          "SELECT id FROM tag_node WHERE app_id=? AND role=? AND kind_uniq='ROOT' LIMIT 1",
          [demoId, role],
        );
        if (!root) continue;
        await pRun(
          'INSERT INTO report_placement (report_id,role,tag_node_id,origin_parent_id) VALUES (?,?,?,?)',
          [rid, role, root.id, root.id],
        );
      }
      console.log('示例报表已创建:', rid);
    }
  } else {
    console.log('示例报表已存在');
  }

  console.log('种子完成。访问：/demo/c（甲方） /demo/d（开发者） /platform/d（平台管理）');
}

main().catch((e) => {
  console.error('SEED ERROR:', e);
  process.exit(1);
});
