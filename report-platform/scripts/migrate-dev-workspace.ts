// 一次性迁移：引入「开发者工作区」dev_workspace —— 一个应用内「甲方自己(OWNER)」+ 多个开发者各自隔离。
// 存量配置归入自动创建的「主开发者」工作区；同时为每个应用补一个空的 OWNER 工作区给甲方自己用。
// 幂等：可重复执行。
//
// 运行：
//   env -u NODE_OPTIONS /Users/skygreen/.workbuddy/binaries/node/versions/22.12.0/bin/node \
//     node_modules/tsx/dist/cli.mjs scripts/migrate-dev-workspace.ts

import fs from 'node:fs';
import crypto from 'node:crypto';
import { pGet, pQuery, pRun } from '@/server/db/platform';

function loadEnv(): void {
  try {
    const txt = fs.readFileSync('.env.local', 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
      if (m) process.env[m[1]] = m[2].trim();
    }
  } catch {
    /* 环境变量已由外部注入时忽略 */
  }
}

async function hasColumn(table: string, col: string): Promise<boolean> {
  const r = await pGet<any>(
    `SELECT COUNT(*) AS c FROM information_schema.columns
     WHERE table_schema=DATABASE() AND table_name=? AND column_name=?`,
    [table, col],
  );
  return Number(r?.c ?? 0) > 0;
}

async function indexColumns(table: string, idx: string): Promise<string[]> {
  const rows = await pQuery<any>(
    `SELECT column_name FROM information_schema.statistics
     WHERE table_schema=DATABASE() AND table_name=? AND index_name=? ORDER BY seq_in_index`,
    [table, idx],
  );
  return rows.map((r: any) => String(r.column_name));
}

function newKey(): string {
  return crypto.randomBytes(9).toString('hex'); // 18 位十六进制，不可猜
}

// 每个工作区一棵开发者目录树（ROOT + 回收站）；甲方侧仍是 ws_id 为 NULL 的单棵树
async function ensureDevTree(appId: string, wsId: string): Promise<void> {
  const sys: [string, string, number][] = [['ROOT', '根目录', 0], ['RECYCLE_BIN', '回收站', 999]];
  for (const [kind, name, sort] of sys) {
    const exist = await pGet<any>(
      'SELECT id FROM tag_node WHERE app_id=? AND role=? AND kind_uniq=? AND ws_id=?',
      [appId, 'DEVELOPER', kind, wsId],
    );
    if (!exist) {
      await pRun(
        'INSERT INTO tag_node (id,app_id,role,ws_id,kind,name,kind_uniq,sort) VALUES (?,?,?,?,?,?,?,?)',
        [crypto.randomUUID(), appId, 'DEVELOPER', wsId, kind, name, kind, sort],
      );
    }
  }
}

async function main(): Promise<void> {
  loadEnv();
  console.log('=== 迁移：dev_workspace（开发者工作区）===\n');

  await pRun(`CREATE TABLE IF NOT EXISTS dev_workspace (
    id         VARCHAR(36) NOT NULL,
    app_id     VARCHAR(36) NOT NULL,
    ws_key     VARCHAR(64) NOT NULL,
    name       VARCHAR(120) NOT NULL,
    kind       ENUM('OWNER','DEVELOPER') NOT NULL DEFAULT 'DEVELOPER',
    status     ENUM('ACTIVE','DISABLED') NOT NULL DEFAULT 'ACTIVE',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_app_key (app_id, ws_key),
    KEY idx_app_kind (app_id, kind, status)
  ) ENGINE=InnoDB`);
  console.log('  ✓ dev_workspace 表就绪');

  for (const [t, c] of [
    ['data_source', 'ws_id'], ['report', 'ws_id'], ['tag_node', 'ws_id'], ['llm_provider', 'ws_id'],
  ] as const) {
    if (!(await hasColumn(t, c))) {
      await pRun(`ALTER TABLE ${t} ADD COLUMN ${c} VARCHAR(36) NULL`);
      console.log(`  + ${t}.${c}`);
    }
  }

  // tag_node：唯一键与父索引都要带上 ws_id（开发者侧每个工作区各一棵树）
  if ((await indexColumns('tag_node', 'uk_system_node')).length === 3) {
    await pRun('ALTER TABLE tag_node DROP INDEX uk_system_node');
    await pRun('ALTER TABLE tag_node ADD UNIQUE KEY uk_system_node (app_id, role, kind_uniq, ws_id)');
    console.log('  ~ tag_node.uk_system_node → (app_id, role, kind_uniq, ws_id)');
  }
  if (!(await indexColumns('tag_node', 'idx_parent')).includes('ws_id')) {
    if ((await indexColumns('tag_node', 'idx_parent')).length) {
      await pRun('ALTER TABLE tag_node DROP INDEX idx_parent');
    }
    await pRun('ALTER TABLE tag_node ADD KEY idx_parent (app_id, role, ws_id, parent_id)');
    console.log('  ~ tag_node.idx_parent → 含 ws_id');
  }
  for (const t of ['data_source', 'report', 'llm_provider']) {
    if (!(await indexColumns(t, 'idx_app_ws')).length) {
      await pRun(`ALTER TABLE ${t} ADD KEY idx_app_ws (app_id, ws_id)`);
      console.log(`  + ${t}.idx_app_ws`);
    }
  }

  const apps = await pQuery<any>('SELECT * FROM application ORDER BY created_at');
  for (const app of apps) {
    // OWNER：甲方自己的开发者配置（访问 /{appPath}/d 不带 ws 参数即进入）
    let owner = await pGet<any>('SELECT * FROM dev_workspace WHERE app_id=? AND kind=?', [app.id, 'OWNER']);
    if (!owner) {
      const id = crypto.randomUUID();
      await pRun(
        `INSERT INTO dev_workspace (id,app_id,ws_key,name,kind,status) VALUES (?,?,?,?,'OWNER','ACTIVE')`,
        [id, app.id, 'owner', '甲方（我自己的配置）'],
      );
      owner = await pGet<any>('SELECT * FROM dev_workspace WHERE id=?', [id]);
      console.log(`  + [${app.path_prefix}] OWNER 工作区（甲方自己的）`);
    }

    // DEVELOPER：存量配置归入「主开发者」
    let main = await pGet<any>(
      `SELECT * FROM dev_workspace WHERE app_id=? AND kind='DEVELOPER' ORDER BY created_at LIMIT 1`,
      [app.id],
    );
    if (!main) {
      const id = crypto.randomUUID();
      await pRun(
        `INSERT INTO dev_workspace (id,app_id,ws_key,name,kind,status) VALUES (?,?,?,?,'DEVELOPER','ACTIVE')`,
        [id, app.id, newKey(), '主开发者'],
      );
      main = await pGet<any>('SELECT * FROM dev_workspace WHERE id=?', [id]);
      console.log(`  + [${app.path_prefix}] 「主开发者」工作区（承接存量配置）`);
    }

    await pRun('UPDATE data_source SET ws_id=? WHERE app_id=? AND ws_id IS NULL', [main.id, app.id]);
    await pRun('UPDATE report SET ws_id=? WHERE app_id=? AND ws_id IS NULL', [main.id, app.id]);
    await pRun(
      `UPDATE llm_provider SET ws_id = CASE WHEN scope='CLIENT' THEN ? ELSE ? END WHERE app_id=? AND ws_id IS NULL`,
      [owner.id, main.id, app.id],
    );
    await pRun(`UPDATE tag_node SET ws_id=? WHERE app_id=? AND role='DEVELOPER' AND ws_id IS NULL`, [main.id, app.id]);

    await ensureDevTree(app.id, owner.id);
    await ensureDevTree(app.id, main.id);
  }

  console.log('\n=== 工作区清单 ===');
  const wss = await pQuery<any>(
    `SELECT w.*, a.path_prefix FROM dev_workspace w JOIN application a ON a.id=w.app_id
     ORDER BY a.path_prefix, w.kind, w.created_at`,
  );
  for (const w of wss) {
    const url = w.kind === 'OWNER' ? `/${w.path_prefix}/d` : `/${w.path_prefix}/d?ws=${w.ws_key}`;
    console.log(`  ${String(w.path_prefix).padEnd(10)} ${w.kind.padEnd(9)} ${String(w.name).padEnd(22)} ${url}`);
  }
  console.log('\n完成。');
  process.exit(0);
}

main().catch((e) => {
  console.error('迁移失败：', e);
  process.exit(1);
});
