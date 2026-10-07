// 入参校验（doc §1：zod）。集中在接口层统一校验。
import { z } from 'zod';

export const GenerateSchema = z.object({
  prompt: z.string().min(1).max(2000),
  // 不传则回落到该应用第一个可用数据源
  dataSourceId: z.string().nullish(),
  currentSql: z.string().nullish(),
  // 指定用哪个模型；不传用该应用默认模型
  providerId: z.string().nullish(),
});

// sql 与 reportId 二选一：给了 reportId 就用报表当前 SQL（REQ-GEN-04）
export const PreviewSchema = z.object({
  reportId: z.string().nullish(),
  sql: z.string().nullish(),
  params: z.record(z.any()).optional().default({}),
  dataSourceId: z.string().nullish(),
});

export const ExportSchema = z.object({
  reportId: z.string().nullish(),
  sql: z.string().nullish(),
  params: z.record(z.any()).optional().default({}),
  format: z.enum(['xlsx', 'csv']),
  dataSourceId: z.string().nullish(),
});

export const SaveReportSchema = z.object({
  name: z.string().min(1).max(120),
  sqlText: z.string().min(1),
  // 不传则回落到该应用第一个可用数据源；前端无参数时可能显式传 null，故一律 nullish
  dataSourceId: z.string().nullish(),
  paramsSchemaJson: z.string().nullish(),
  parentNodeId: z.string().nullish(),
});

export const CreateDsSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().positive(),
  database_name: z.string().min(1),
  username: z.string().min(1),
  password: z.string(),
  sensitive_columns_json: z.string().nullish(),
});

export const CreateAppSchema = z.object({
  name: z.string().min(1),
  pathPrefix: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),
  host: z.string().nullish(),
});

export const UpdateSqlSchema = z.object({
  sqlText: z.string().min(1),
  note: z.string().nullish(),
});

// 模型服务商 / 本地模型（endpoint + model + apiKey，OpenAI 兼容）
export const LlmProviderSchema = z.object({
  name: z.string().min(1).max(120),
  vendor: z.string().nullish(),
  endpoint: z.string().min(1).max(255),
  model: z.string().min(1).max(120),
  apiKey: z.string().nullish(), // 留空 = 不填密钥（本地模型）或不改动（更新时）
  isDefault: z.boolean().nullish(),
  status: z.enum(['ACTIVE', 'DISABLED']).nullish(),
});

export const RequirementSchema = z.object({
  prompt: z.string().nullish(),
  failedSql: z.string().nullish(),
  errorMsg: z.string().nullish(),
  clientNote: z.string().nullish(),
  reportId: z.string().nullish(),
});
