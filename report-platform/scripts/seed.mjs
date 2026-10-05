// 首次部署种子数据（node --env-file=.env.local scripts/seed.mjs）。
// 平台根应用 + 示例应用 + 只读数据源（AES 加密）+ 两棵树 + 示例报表。
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(process.env.APP_ENC_KEY, 'base64'), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}
const uuid = () => crypto.randomUUID();

const cfg = {
  host: process.env.PLATFORM_DB_HOST,
  port: Number(process.env.PLATFORM_DB_PORT),
  user: process.env.PLATFORM_DB_USER,
  password: process.env.PLATFORM_DB_PASSWORD,
  database: process.env.PLATFORM_DB_NAME,
};

const settings = (defaultDs) => JSON.stringify({
  clientCanViewSql: true,
  maxRows: Number(process.env.DEFAULT_MAX_ROWS ?? 200),
  timeoutMs: Number(process.env.DEFAULT_TIMEOUT_MS ?? 15000),
  exportFileTtlHours: 24,
  purgeGraceDays: 7,
  embedMode: false,
  llm: { endpoint: process.env.LLM_BASE_URL, model: process.env.LLM_MODEL },
  defaultDs,
});

async function initTrees(conn, appId) {
  for (const role of ['CLIENT', 'DEVELOPER']) {
    await conn.execute(
      `INSERT IGNORE INTO tag_node (id,app_id,role,kind,name,kind_uniq,sort) VALUES (?,?,?,'ROOT','根目录','ROOT',0)`,
      [uuid(), appId, role]);
    await conn.execute(
      `INSERT IGNORE INTO tag_node (id,app_id,role,kind,name,kind_uniq,sort) VALUES (?,?,?,'RECYCLE_BIN','回收站','RECYCLE_BIN',999)`,
      [uuid(), appId, role]);
  }
}

async function main() {
  const conn = await mysql.createConnection(cfg);

  // 平台根应用
  let [rows] = await conn.execute('SELECT id FROM application WHERE is_platform_root=1');
  let rootId;
  if (!rows.length) {
    rootId = uuid();
    await conn.execute(
      'INSERT INTO application (id,name,host,path_prefix,status,is_platform_root,settings_json) VALUES (?,?,?,?,?,?,?)',
      [rootId, '平台根', '', 'platform', 'ACTIVE', 1, settings(null)]);
    await initTrees(conn, rootId);
    console.log('平台根应用已创建:', rootId);
  } else {
    rootId = rows[0].id;
    console.log('平台根应用已存在:', rootId);
  }

  // 示例应用
  [rows] = await conn.execute("SELECT id FROM application WHERE path_prefix='demo'");
  let demoId;
  if (!rows.length) {
    demoId = uuid();
    await conn.execute(
      'INSERT INTO application (id,name,host,path_prefix,status,is_platform_root,settings_json) VALUES (?,?,?,?,?,?,?)',
      [demoId, '示例报表应用', '', 'demo', 'ACTIVE', 0, settings(null)]);
    await initTrees(conn, demoId);
    console.log('示例应用已创建:', demoId);
  } else {
    demoId = rows[0].id;
    console.log('示例应用已存在:', demoId);
  }

  // 数据源（只读账号，AES 加密）
  [rows] = await conn.execute('SELECT id FROM data_source WHERE app_id=?', [demoId]);
  let dsId;
  if (!rows.length) {
    dsId = uuid();
    await conn.execute(
      `INSERT INTO data_source (id,app_id,name,host,port,database_name,username,password_enc,status)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [dsId, demoId, '业务只读库', process.env.BIZ_DB_HOST, Number(process.env.BIZ_DB_PORT),
       process.env.BIZ_DB_NAME, process.env.BIZ_DB_USER, encrypt(process.env.BIZ_DB_PASSWORD), 'ACTIVE']);
    console.log('数据源已创建:', dsId);
    // 把 defaultDs 写回示例应用设置
    await conn.execute('UPDATE application SET settings_json=? WHERE id=?', [settings(dsId), demoId]);
  } else {
    dsId = rows[0].id;
    await conn.execute('UPDATE application SET settings_json=? WHERE id=?', [settings(dsId), demoId]);
    console.log('数据源已存在:', dsId);
  }

  // 示例报表（双轨各一条 placement + 初始 SQL 版本）
  [rows] = await conn.execute('SELECT id FROM report WHERE app_id=? AND name=?', [demoId, '各地区订单汇总']);
  if (!rows.length) {
    const rid = uuid();
    const sql = 'SELECT region, COUNT(*) AS cnt, SUM(amount) AS total_amount FROM orders GROUP BY region ORDER BY total_amount DESC';
    await conn.execute(
      'INSERT INTO report (id,app_id,name,sql_text,data_source_id,client_state,developer_state) VALUES (?,?,?,?,?,?,?)',
      [rid, demoId, '各地区订单汇总', sql, dsId, 'NORMAL', 'NORMAL']);
    const vid = uuid();
    await conn.execute(
      'INSERT INTO sql_version (id,report_id,app_id,sql_text,note,created_by_role) VALUES (?,?,?,?,\'初始版本\',?)',
      [vid, rid, demoId, sql, 'DEVELOPER']);
    await conn.execute('UPDATE report SET current_sql_version_id=? WHERE id=?', [vid, rid]);
    for (const role of ['CLIENT', 'DEVELOPER']) {
      const [root] = await conn.execute("SELECT id FROM tag_node WHERE app_id=? AND role=? AND kind_uniq='ROOT'", [demoId, role]);
      await conn.execute(
        'INSERT INTO report_placement (report_id,role,tag_node_id,origin_parent_id) VALUES (?,?,?,?)',
        [rid, role, root[0].id, root[0].id]);
    }
    console.log('示例报表已创建:', rid);
  } else {
    console.log('示例报表已存在');
  }

  await conn.end();
  console.log('种子完成。访问：http://localhost:3000/demo/c  （甲方）  /  http://localhost:3000/demo/d  （开发者）');
}

main().catch((e) => { console.error('SEED ERROR:', e); process.exit(1); });
