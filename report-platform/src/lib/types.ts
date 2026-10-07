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

export interface DataSourceRow {
  id: string;
  app_id: string;
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
}

export type RunSource = 'PREVIEW' | 'EXPORT' | 'SAVE' | 'DEV_DEBUG';
