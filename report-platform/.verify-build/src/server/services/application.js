"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApplication = createApplication;
exports.disableApplication = disableApplication;
exports.listApplications = listApplications;
exports.ensurePlatformRoot = ensurePlatformRoot;
// 应用服务（doc §5、§17.1）。平台根应用创建/停用；普通应用创建后初始化两棵树（REQ-ACC-10/11/13）。
const platform_1 = require("../db/platform");
const tagTree_1 = require("./tagTree");
const errors_1 = require("../errors");
const node_crypto_1 = __importDefault(require("node:crypto"));
const context_1 = require("../context");
async function createApplication(input) {
    const id = node_crypto_1.default.randomUUID();
    const settings = {
        clientCanViewSql: false,
        maxRows: Number(process.env.DEFAULT_MAX_ROWS ?? 200),
        timeoutMs: Number(process.env.DEFAULT_TIMEOUT_MS ?? 15000),
        exportFileTtlHours: 24,
        purgeGraceDays: 7,
        embedMode: false,
        llm: { endpoint: process.env.LLM_BASE_URL ?? '', model: process.env.LLM_MODEL ?? 'deepseek-chat' },
        defaultDs: null,
        ...(input.settings ?? {}),
    };
    await (0, platform_1.pRun)(`INSERT INTO application (id,name,host,path_prefix,status,is_platform_root,settings_json)
     VALUES (?,?,?,?,?,?,?)`, [id, input.name, input.host ?? '', input.pathPrefix, 'ACTIVE', 0, JSON.stringify(settings)]);
    await (0, tagTree_1.initTrees)(id); // 初始化两棵标签树（REQ-ACC-11）
    return id;
}
// 仅平台根应用可用（REQ-ACC-10）。停用根应用被拒（REQ-ACC-13）。
async function disableApplication(ctx, id) {
    if (!ctx.app.is_platform_root)
        throw new errors_1.HttpError(403, 'NOT_PLATFORM_ROOT');
    const app = await (0, platform_1.pGet)('SELECT * FROM application WHERE id=?', [id]);
    if (!app)
        throw new errors_1.HttpError(404, 'APP_NOT_FOUND');
    if (app.is_platform_root)
        throw new errors_1.HttpError(400, 'CANNOT_DISABLE_ROOT'); // REQ-ACC-13
    await (0, platform_1.pRun)("UPDATE application SET status='DISABLED' WHERE id=?", [id]);
    (0, context_1.invalidateAppCache)(app.host, app.path_prefix); // 即时失效缓存（REQ-ACC-07）
}
async function listApplications() {
    return (0, platform_1.pQuery)('SELECT * FROM application ORDER BY is_platform_root DESC, created_at');
}
// 初始化平台根应用（首次部署 seed 调用）
async function ensurePlatformRoot() {
    const existing = await (0, platform_1.pGet)('SELECT * FROM application WHERE is_platform_root=1');
    if (existing)
        return existing.id;
    const id = node_crypto_1.default.randomUUID();
    const settings = {
        clientCanViewSql: false,
        maxRows: Number(process.env.DEFAULT_MAX_ROWS ?? 200),
        timeoutMs: Number(process.env.DEFAULT_TIMEOUT_MS ?? 15000),
        exportFileTtlHours: 24,
        purgeGraceDays: 7,
        embedMode: false,
        llm: { endpoint: process.env.LLM_BASE_URL ?? '', model: process.env.LLM_MODEL ?? 'deepseek-chat' },
        defaultDs: null,
    };
    await (0, platform_1.pRun)(`INSERT INTO application (id,name,host,path_prefix,status,is_platform_root,settings_json)
     VALUES (?,?,?,?,?,?,?)`, [id, '平台根', '', 'platform', 'ACTIVE', 1, JSON.stringify(settings)]);
    await (0, tagTree_1.initTrees)(id);
    return id;
}
