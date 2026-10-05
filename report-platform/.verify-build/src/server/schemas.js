"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RequirementSchema = exports.UpdateSqlSchema = exports.CreateAppSchema = exports.CreateDsSchema = exports.SaveReportSchema = exports.ExportSchema = exports.PreviewSchema = exports.GenerateSchema = void 0;
// 入参校验（doc §1：zod）。集中在接口层统一校验。
const zod_1 = require("zod");
exports.GenerateSchema = zod_1.z.object({
    prompt: zod_1.z.string().min(1).max(2000),
    // 不传则回落到该应用第一个可用数据源
    dataSourceId: zod_1.z.string().optional(),
    currentSql: zod_1.z.string().optional(),
});
// sql 与 reportId 二选一：给了 reportId 就用报表当前 SQL（REQ-GEN-04）
exports.PreviewSchema = zod_1.z.object({
    reportId: zod_1.z.string().optional(),
    sql: zod_1.z.string().optional(),
    params: zod_1.z.record(zod_1.z.any()).optional().default({}),
    dataSourceId: zod_1.z.string().optional(),
});
exports.ExportSchema = zod_1.z.object({
    reportId: zod_1.z.string().optional(),
    sql: zod_1.z.string().optional(),
    params: zod_1.z.record(zod_1.z.any()).optional().default({}),
    format: zod_1.z.enum(['xlsx', 'csv']),
    dataSourceId: zod_1.z.string().optional(),
});
exports.SaveReportSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(120),
    sqlText: zod_1.z.string().min(1),
    // 不传则回落到该应用第一个可用数据源
    dataSourceId: zod_1.z.string().optional(),
    paramsSchemaJson: zod_1.z.string().optional(),
    parentNodeId: zod_1.z.string().optional(),
});
exports.CreateDsSchema = zod_1.z.object({
    name: zod_1.z.string().min(1),
    host: zod_1.z.string().min(1),
    port: zod_1.z.number().int().positive(),
    database_name: zod_1.z.string().min(1),
    username: zod_1.z.string().min(1),
    password: zod_1.z.string(),
    sensitive_columns_json: zod_1.z.string().optional(),
});
exports.CreateAppSchema = zod_1.z.object({
    name: zod_1.z.string().min(1),
    pathPrefix: zod_1.z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),
    host: zod_1.z.string().optional(),
});
exports.UpdateSqlSchema = zod_1.z.object({
    sqlText: zod_1.z.string().min(1),
    note: zod_1.z.string().optional(),
});
exports.RequirementSchema = zod_1.z.object({
    prompt: zod_1.z.string().optional(),
    failedSql: zod_1.z.string().optional(),
    errorMsg: zod_1.z.string().optional(),
    clientNote: zod_1.z.string().optional(),
    reportId: zod_1.z.string().optional(),
});
