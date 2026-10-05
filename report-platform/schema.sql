-- 企业报表平台 · 平台元库建表
-- 对应文档 §4。MySQL 8+（含 9.x）。直接 mysql < schema.sql 执行。
-- 业务只读库 biz_demo 与只读账号 report_ro 由 scripts/setup-infra.sql 创建。

CREATE DATABASE IF NOT EXISTS report_platform CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE report_platform;

SET NAMES utf8mb4;

-- ---------- application ----------
CREATE TABLE IF NOT EXISTS application (
  id            VARCHAR(36)  NOT NULL,
  name          VARCHAR(120) NOT NULL,
  host          VARCHAR(255) NOT NULL DEFAULT '',
  path_prefix   VARCHAR(120) NOT NULL,
  status        ENUM('ACTIVE','DISABLED') NOT NULL DEFAULT 'ACTIVE',
  is_platform_root TINYINT(1) NOT NULL DEFAULT 0,
  settings_json MEDIUMTEXT,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- 路由解析歧义 → 串应用（REQ-ACC-03/12）
  UNIQUE KEY uk_host_path (host, path_prefix),
  -- 平台根应用全局唯一（REQ-ACC-10/13）：仅当 is_platform_root=1 时取值唯一，否则为 NULL 不约束
  UNIQUE KEY uk_platform_root ((CASE WHEN is_platform_root=1 THEN 1 ELSE NULL END))
) ENGINE=InnoDB;

-- ---------- data_source ----------
CREATE TABLE IF NOT EXISTS data_source (
  id                 VARCHAR(36) NOT NULL,
  app_id             VARCHAR(36) NOT NULL,
  name               VARCHAR(120) NOT NULL,
  host               VARCHAR(255) NOT NULL,
  port               INT NOT NULL,
  database_name      VARCHAR(120) NOT NULL,
  username           VARCHAR(120) NOT NULL,
  password_enc       MEDIUMTEXT   NOT NULL,   -- AES-256-GCM 密文
  status             ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  catalog_json       MEDIUMTEXT,              -- 元数据缓存（库/表/字段/注释）
  sensitive_columns_json MEDIUMTEXT,          -- 脱敏策略
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_app (app_id)
) ENGINE=InnoDB;

-- ---------- report ----------
CREATE TABLE IF NOT EXISTS report (
  id                     VARCHAR(36) NOT NULL,
  app_id                 VARCHAR(36) NOT NULL,
  name                   VARCHAR(120) NOT NULL,
  sql_text               MEDIUMTEXT NOT NULL,
  data_source_id         VARCHAR(36),
  params_schema_json     MEDIUMTEXT,
  current_sql_version_id VARCHAR(36),
  client_state           ENUM('NORMAL','RECYCLED','PURGED') NOT NULL DEFAULT 'NORMAL',
  developer_state        ENUM('NORMAL','RECYCLED','PURGED') NOT NULL DEFAULT 'NORMAL',
  client_recycled_at     DATETIME,
  developer_recycled_at  DATETIME,
  client_purged_at       DATETIME,
  purge_due_at           DATETIME,
  created_by             VARCHAR(36),
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- 同名报表全局唯一，PURGED 也占名（REQ-SAVE-05）
  UNIQUE KEY uk_app_name (app_id, name),
  KEY idx_client (app_id, client_state),
  KEY idx_developer (app_id, developer_state),
  KEY idx_ds (data_source_id)
) ENGINE=InnoDB;

-- ---------- tag_node ----------
CREATE TABLE IF NOT EXISTS tag_node (
  id         VARCHAR(36) NOT NULL,
  app_id     VARCHAR(36) NOT NULL,
  role       ENUM('CLIENT','DEVELOPER') NOT NULL,
  kind       ENUM('ROOT','NORMAL','RECYCLE_BIN') NOT NULL DEFAULT 'NORMAL',
  parent_id  VARCHAR(36),
  name       VARCHAR(120),
  sort       INT NOT NULL DEFAULT 0,
  -- 系统节点唯一性（ROOT / RECYCLE_BIN），普通目录此项为 NULL（REQ-TAG-01/03）
  kind_uniq  ENUM('ROOT','RECYCLE_BIN') NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- MySQL 唯一索引允许重复 NULL → 模拟部分唯一索引（§4.2）
  UNIQUE KEY uk_system_node (app_id, role, kind_uniq),
  KEY idx_parent (app_id, role, parent_id)
) ENGINE=InnoDB;

-- ---------- report_placement（双轨：一份报表每角色一棵树一条）----------
CREATE TABLE IF NOT EXISTS report_placement (
  report_id      VARCHAR(36) NOT NULL,
  role           ENUM('CLIENT','DEVELOPER') NOT NULL,
  tag_node_id    VARCHAR(36) NOT NULL,
  origin_parent_id VARCHAR(36),
  recycled_at    DATETIME,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (report_id, role),   -- (report_id, role) 唯一（REQ-TAG-05、DP-02）
  KEY idx_node (tag_node_id)
) ENGINE=InnoDB;

-- ---------- requirement（协作需求，多轮留痕）----------
CREATE TABLE IF NOT EXISTS requirement (
  id            VARCHAR(36) NOT NULL,
  app_id        VARCHAR(36) NOT NULL,
  report_id     VARCHAR(36),
  status        ENUM('OPEN','IN_PROGRESS','PENDING_CONFIRM','CONFIRMED','REJECTED') NOT NULL DEFAULT 'OPEN',
  prompt        MEDIUMTEXT,
  failed_sql    MEDIUMTEXT,
  error_msg     MEDIUMTEXT,
  client_note   MEDIUMTEXT,
  client_key    VARCHAR(64),
  created_by_role ENUM('CLIENT','DEVELOPER'),
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_report (report_id),
  KEY idx_app_status (app_id, status)
) ENGINE=InnoDB;

-- ---------- sql_version（追加不可变）----------
CREATE TABLE IF NOT EXISTS sql_version (
  id            VARCHAR(36) NOT NULL,
  report_id     VARCHAR(36) NOT NULL,
  app_id        VARCHAR(36) NOT NULL,
  sql_text      MEDIUMTEXT NOT NULL,
  note          MEDIUMTEXT,
  created_by_role ENUM('CLIENT','DEVELOPER'),
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_report (report_id)
) ENGINE=InnoDB;

-- ---------- run_record（每次执行留痕，含 REJECTED）----------
CREATE TABLE IF NOT EXISTS run_record (
  id            VARCHAR(36) NOT NULL,
  app_id        VARCHAR(36) NOT NULL,
  report_id     VARCHAR(36),
  data_source_id VARCHAR(36),
  source        ENUM('PREVIEW','EXPORT','SAVE','DEV_DEBUG') NOT NULL,
  result        ENUM('SUCCESS','FAILED','REJECTED') NOT NULL,
  sql_text      MEDIUMTEXT,
  params_json   MEDIUMTEXT,
  row_count     INT,
  ms            INT,
  error_code    VARCHAR(40),
  client_key    VARCHAR(64),
  started_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_app_src (app_id, source),
  KEY idx_client (app_id, client_key, started_at)
) ENGINE=InnoDB;

-- ---------- audit_log（审计，按月分区预留；本脚本用普通表，分区迁移见 doc §4.1）----------
CREATE TABLE IF NOT EXISTS audit_log (
  id            VARCHAR(36) NOT NULL,
  app_id        VARCHAR(36) NOT NULL,
  actor_role    ENUM('CLIENT','DEVELOPER'),
  action        VARCHAR(40),
  target_type   VARCHAR(40),
  target_id     VARCHAR(36),
  detail_json   MEDIUMTEXT,
  client_key    VARCHAR(64),
  started_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id, started_at),
  KEY idx_app_time (app_id, started_at)
) ENGINE=InnoDB
PARTITION BY RANGE (TO_DAYS(started_at)) (
  PARTITION p_init VALUES LESS THAN (TO_DAYS('2030-01-01'))
);

-- ---------- export_task（导出任务，TTL 默认 24h）----------
CREATE TABLE IF NOT EXISTS export_task (
  id            VARCHAR(36) NOT NULL,
  app_id        VARCHAR(36) NOT NULL,
  report_id     VARCHAR(36),
  data_source_id VARCHAR(36),
  sql_text      MEDIUMTEXT,
  params_json   MEDIUMTEXT,
  format        ENUM('xlsx','csv') NOT NULL,
  status        ENUM('RUNNING','DONE','FAILED','EXPIRED') NOT NULL DEFAULT 'RUNNING',
  file_key      VARCHAR(255),
  row_count     INT,
  client_key    VARCHAR(64),
  started_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at    DATETIME,
  finished_at   DATETIME,
  error_msg     MEDIUMTEXT,
  PRIMARY KEY (id),
  KEY idx_app_client (app_id, client_key, started_at)
) ENGINE=InnoDB;
