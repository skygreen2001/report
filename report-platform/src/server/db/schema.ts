// 平台元库建表语句（SQLite）。与仓库根目录 schema.sql 保持一致。
// 运行时直接内嵌在代码里，避免部署产物依赖外部 .sql 文件。
export const PLATFORM_SCHEMA_SQL = `
-- ---------- application ----------
CREATE TABLE IF NOT EXISTS application (
  id                TEXT NOT NULL PRIMARY KEY,
  name              TEXT NOT NULL,
  host              TEXT NOT NULL DEFAULT '',
  path_prefix       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  is_platform_root  INTEGER NOT NULL DEFAULT 0,
  settings_json     TEXT,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_host_path ON application(host, path_prefix);
-- 平台根应用全局唯一：仅 is_platform_root=1 的行参与唯一约束（部分唯一索引）
CREATE UNIQUE INDEX IF NOT EXISTS uk_platform_root ON application(is_platform_root) WHERE is_platform_root = 1;

-- ---------- dev_workspace（开发者工作区：每个使用者一套隔离配置）----------
CREATE TABLE IF NOT EXISTS dev_workspace (
  id          TEXT NOT NULL PRIMARY KEY,
  app_id      TEXT NOT NULL,
  ws_key      TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'DEVELOPER' CHECK (kind IN ('OWNER','DEVELOPER')),
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  claimed     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_app_key ON dev_workspace(app_id, ws_key);
CREATE INDEX IF NOT EXISTS idx_app_kind ON dev_workspace(app_id, kind, status);

-- ---------- data_source ----------
CREATE TABLE IF NOT EXISTS data_source (
  id                     TEXT NOT NULL PRIMARY KEY,
  app_id                 TEXT NOT NULL,
  ws_id                  TEXT,
  name                   TEXT NOT NULL,
  host                   TEXT NOT NULL,
  port                   INTEGER NOT NULL,
  database_name          TEXT NOT NULL,
  username               TEXT NOT NULL,
  password_enc           TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  catalog_json           TEXT,
  schema_doc_json        TEXT,
  schema_doc_at          TEXT,
  sensitive_columns_json TEXT,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_app ON data_source(app_id);
CREATE INDEX IF NOT EXISTS idx_ds_app_ws ON data_source(app_id, ws_id);

-- ---------- report ----------
CREATE TABLE IF NOT EXISTS report (
  id                     TEXT NOT NULL PRIMARY KEY,
  app_id                 TEXT NOT NULL,
  ws_id                  TEXT,
  name                   TEXT NOT NULL,
  sql_text               TEXT NOT NULL,
  data_source_id         TEXT,
  params_schema_json     TEXT,
  current_sql_version_id TEXT,
  client_state           TEXT NOT NULL DEFAULT 'NORMAL' CHECK (client_state IN ('NORMAL','RECYCLED','PURGED')),
  developer_state        TEXT NOT NULL DEFAULT 'NORMAL' CHECK (developer_state IN ('NORMAL','RECYCLED','PURGED')),
  client_recycled_at     TEXT,
  developer_recycled_at  TEXT,
  client_purged_at       TEXT,
  purge_due_at           TEXT,
  created_by             TEXT,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_app_name ON report(app_id, name);
CREATE INDEX IF NOT EXISTS idx_client ON report(app_id, client_state);
CREATE INDEX IF NOT EXISTS idx_developer ON report(app_id, developer_state);
CREATE INDEX IF NOT EXISTS idx_report_ds ON report(data_source_id);
CREATE INDEX IF NOT EXISTS idx_report_app_ws ON report(app_id, ws_id);

-- ---------- tag_node ----------
CREATE TABLE IF NOT EXISTS tag_node (
  id         TEXT NOT NULL PRIMARY KEY,
  app_id     TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('CLIENT','DEVELOPER')),
  ws_id      TEXT,
  kind       TEXT NOT NULL DEFAULT 'NORMAL' CHECK (kind IN ('ROOT','NORMAL','RECYCLE_BIN')),
  parent_id  TEXT,
  name       TEXT,
  sort       INTEGER NOT NULL DEFAULT 0,
  kind_uniq  TEXT CHECK (kind_uniq IN ('ROOT','RECYCLE_BIN') OR kind_uniq IS NULL),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- SQLite 唯一索引同样允许多个 NULL → 等价于 MySQL 的部分唯一索引行为
CREATE UNIQUE INDEX IF NOT EXISTS uk_system_node ON tag_node(app_id, role, kind_uniq, ws_id);
CREATE INDEX IF NOT EXISTS idx_parent ON tag_node(app_id, role, ws_id, parent_id);

-- ---------- report_placement（双轨：一份报表每角色一棵树一条）----------
CREATE TABLE IF NOT EXISTS report_placement (
  report_id        TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('CLIENT','DEVELOPER')),
  tag_node_id      TEXT NOT NULL,
  origin_parent_id TEXT,
  recycled_at      TEXT,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (report_id, role)
);
CREATE INDEX IF NOT EXISTS idx_node ON report_placement(tag_node_id);

-- ---------- requirement（协作需求，多轮留痕）----------
CREATE TABLE IF NOT EXISTS requirement (
  id              TEXT NOT NULL PRIMARY KEY,
  app_id          TEXT NOT NULL,
  report_id       TEXT,
  status          TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','PENDING_CONFIRM','CONFIRMED','REJECTED')),
  prompt          TEXT,
  failed_sql      TEXT,
  error_msg       TEXT,
  client_note     TEXT,
  client_key      TEXT,
  created_by_role TEXT CHECK (created_by_role IN ('CLIENT','DEVELOPER') OR created_by_role IS NULL),
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_report ON requirement(report_id);
CREATE INDEX IF NOT EXISTS idx_app_status ON requirement(app_id, status);

-- ---------- sql_version（追加不可变）----------
CREATE TABLE IF NOT EXISTS sql_version (
  id              TEXT NOT NULL PRIMARY KEY,
  report_id       TEXT NOT NULL,
  app_id          TEXT NOT NULL,
  sql_text        TEXT NOT NULL,
  note            TEXT,
  created_by_role TEXT CHECK (created_by_role IN ('CLIENT','DEVELOPER') OR created_by_role IS NULL),
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sqlver_report ON sql_version(report_id);

-- ---------- run_record（每次执行留痕，含 REJECTED）----------
CREATE TABLE IF NOT EXISTS run_record (
  id             TEXT NOT NULL PRIMARY KEY,
  app_id         TEXT NOT NULL,
  report_id      TEXT,
  data_source_id TEXT,
  source         TEXT NOT NULL CHECK (source IN ('PREVIEW','EXPORT','SAVE','DEV_DEBUG')),
  result         TEXT NOT NULL CHECK (result IN ('SUCCESS','FAILED','REJECTED')),
  sql_text       TEXT,
  params_json    TEXT,
  row_count      INTEGER,
  ms             INTEGER,
  error_code     TEXT,
  client_key     TEXT,
  started_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_app_src ON run_record(app_id, source);
CREATE INDEX IF NOT EXISTS idx_run_client ON run_record(app_id, client_key, started_at);

-- ---------- audit_log（审计）----------
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT NOT NULL,
  app_id      TEXT NOT NULL,
  actor_role  TEXT CHECK (actor_role IN ('CLIENT','DEVELOPER') OR actor_role IS NULL),
  action      TEXT,
  target_type TEXT,
  target_id   TEXT,
  detail_json TEXT,
  client_key  TEXT,
  started_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id, started_at)
);
CREATE INDEX IF NOT EXISTS idx_app_time ON audit_log(app_id, started_at);

-- ---------- export_task（导出任务，TTL 默认 24h）----------
CREATE TABLE IF NOT EXISTS export_task (
  id             TEXT NOT NULL PRIMARY KEY,
  app_id         TEXT NOT NULL,
  report_id      TEXT,
  data_source_id TEXT,
  sql_text       TEXT,
  params_json    TEXT,
  format         TEXT NOT NULL CHECK (format IN ('xlsx','csv')),
  status         TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','DONE','FAILED','EXPIRED')),
  file_key       TEXT,
  row_count      INTEGER,
  client_key     TEXT,
  started_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at     TEXT,
  finished_at    TEXT,
  error_msg      TEXT
);
CREATE INDEX IF NOT EXISTS idx_export_client ON export_task(app_id, client_key, started_at);

-- ---------- llm_provider（模型服务商 / 本地自建模型）----------
CREATE TABLE IF NOT EXISTS llm_provider (
  id          TEXT NOT NULL PRIMARY KEY,
  app_id      TEXT NOT NULL,
  ws_id       TEXT,
  scope       TEXT NOT NULL DEFAULT 'DEVELOPER' CHECK (scope IN ('DEVELOPER','CLIENT')),
  name        TEXT NOT NULL,
  vendor      TEXT NOT NULL DEFAULT 'custom',
  endpoint    TEXT NOT NULL,
  model       TEXT NOT NULL,
  api_key_enc TEXT,
  is_default  INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_llm_app ON llm_provider(app_id);
CREATE INDEX IF NOT EXISTS idx_llm_app_ws ON llm_provider(app_id, ws_id);
`;

// SQLite 没有 ON UPDATE CURRENT_TIMESTAMP，用触发器补齐（默认不递归触发）。
const UPDATED_AT_TABLES = [
  'application',
  'dev_workspace',
  'data_source',
  'report',
  'requirement',
  'llm_provider',
];

export const PLATFORM_TRIGGERS_SQL = UPDATED_AT_TABLES.map(
  (t) => `CREATE TRIGGER IF NOT EXISTS trg_${t}_updated_at AFTER UPDATE ON ${t}
FOR EACH ROW BEGIN
  UPDATE ${t} SET updated_at = CURRENT_TIMESTAMP WHERE rowid = NEW.rowid;
END;`,
).join('\n');
