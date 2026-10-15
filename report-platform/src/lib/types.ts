// 共享类型定义

export type Role = 'CLIENT' | 'DEVELOPER';

export interface AppSettings {
  clientCanViewSql: boolean;
  maxRows: number;
  timeoutMs: number;
  exportFileTtlHours: number;
  purgeGraceDays: number;
  embedMode: boolean;
  llm: { endpoint: string; model: string };
  defaultDs: string | null;
}

export interface ApplicationRow {
  id: string;
  name: string;
  host: string;
  path_prefix: string;
  status: 'ACTIVE' | 'DISABLED';
  is_platform_root: 0 | 1;
  settings_json: string | null;
}

// 开发者工作区：每个使用者（= 一个浏览器身份）一套隔离配置，人人平等，没有特殊甲方。
// 身份 = 中间件首次访问时生成并写入浏览器的随机串（ws_key），也可用 ?ws=<key> 链接搬到别的设备。
// /d 只看自己身份下的配置；/c 汇总所有身份产出的报表。
export type WorkspaceKind = 'OWNER' | 'DEVELOPER';
export interface DevWorkspaceRow {
  id: string;
  app_id: string;
  ws_key: string;
  name: string;
  kind: WorkspaceKind;
  status: 'ACTIVE' | 'DISABLED';
  // 0 = 尚未归属任何浏览器（存量/新建应用时的候选）；首次被访问即认领为 1 并绑定 ws_key
  claimed: 0 | 1;
  created_at: string;
  updated_at: string;
}

export interface DataSourceRow {
  id: string;
  app_id: string;
  ws_id: string | null;
  name: string;
  host: string;
  port: number;
  database_name: string;
  username: string;
  password_enc: string;
  status: 'ACTIVE' | 'INACTIVE';
  catalog_json: string | null;
  schema_doc_json?: string | null; // 数据库结构文档缓存
  schema_doc_at?: string | null;
  sensitive_columns_json: string | null;
}

export interface ReportRow {
  id: string;
  app_id: string;
  ws_id: string | null;
  name: string;
  sql_text: string;
  data_source_id: string | null;
  params_schema_json: string | null;
  current_sql_version_id: string | null;
  client_state: 'NORMAL' | 'RECYCLED' | 'PURGED';
  developer_state: 'NORMAL' | 'RECYCLED' | 'PURGED';
  client_recycled_at: string | null;
  developer_recycled_at: string | null;
  client_purged_at: string | null;
  purge_due_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface LlmProviderRow {
  id: string;
  app_id: string;
  ws_id: string | null;
  scope: 'DEVELOPER' | 'CLIENT';
  name: string;
  vendor: string;
  endpoint: string;
  model: string;
  api_key_enc: string | null; // AES-256-GCM 密文，接口永不返回
  is_default: 0 | 1;
  status: 'ACTIVE' | 'DISABLED';
  created_at: string;
  updated_at: string;
}

export interface ParamField {
  name: string;
  label?: string;
  type: 'string' | 'number' | 'date' | 'enum';
  required?: boolean;
  options?: string[]; // enum
  default?: string | number; // 支持 last7d/last30d/thisMonth/lastMonth 预设（Q-12）
}

export interface SensitiveColumn {
  table: string;
  column: string;
  strategy: 'mask' | 'hash';
}

export interface RoleContext {
  appId: string;
  role: Role;
  clientKey: string;
  settings: AppSettings;
  app: ApplicationRow;
  // 当前「人」的工作区：开发者配置按人隔离的关键维度。
  // 身份由浏览器 Cookie 承载（首次访问随机生成）；wsKey 即该身份本身，换设备时用 ?ws=<wsKey> 带走。
  wsId: string;
  wsKey: string;
}

export type RunSource = 'PREVIEW' | 'EXPORT' | 'SAVE' | 'DEV_DEBUG';
