"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateSql = generateSql;
// NL2SQL 生成（doc §5、§17.7）。出网仅含元数据+提示词+当前模板；失败降级手工模式(REQ-GEN-09)。
const openai_1 = __importDefault(require("openai"));
const datasource_1 = require("./datasource");
const audit_1 = require("./audit");
const SYS_PROMPT = '你是企业报表平台的 SQL 生成助手。只输出一条 MySQL SELECT（或 WITH...SELECT）只读查询，禁止任何写操作、禁止系统库、禁止 INTO OUTFILE、禁止 SLEEP 等危险函数。参数用 {{name}} 占位（仅值位置）。只返回 SQL，不要解释。';
// 出网内容仅含元数据（表名/列名/注释）+ 用户提示词，不含任何业务数据（doc §17.7）
function buildUserPrompt(prompt, catalog, currentSql) {
    const meta = catalog
        .map((t) => `表 ${t.table}: ${(t.columns ?? []).map((c) => c.column_name).join(', ')}`)
        .join('\n');
    return `可用元数据：\n${meta}\n\n用户需求：${prompt}${currentSql ? `\n\n当前 SQL（在此基础上修改）：\n${currentSql}` : ''}`;
}
function buildClient(endpoint, apiKey) {
    return new openai_1.default({ apiKey, baseURL: endpoint, timeout: 20_000 });
}
async function generateSql(ctx, input) {
    const ds = await (0, datasource_1.loadDataSource)(input.dataSourceId);
    const endpoint = ctx.settings.llm.endpoint || process.env.LLM_BASE_URL || '';
    const apiKey = process.env.LLM_API_KEY || '';
    const model = ctx.settings.llm.model || process.env.LLM_MODEL || 'deepseek-chat';
    if (!endpoint || !apiKey) {
        return { mode: 'manual', sql: null, reason: '未配置 LLM 端点' };
    }
    const catalog = await (0, datasource_1.getCatalog)(ds);
    try {
        const client = buildClient(endpoint, apiKey);
        const completion = await client.chat.completions.create({
            model,
            messages: [
                { role: 'system', content: SYS_PROMPT },
                { role: 'user', content: buildUserPrompt(input.prompt, catalog, input.currentSql) },
            ],
            temperature: 0,
        });
        let sql = completion.choices[0]?.message?.content?.trim() ?? '';
        sql = sql.replace(/^```(?:sql)?/i, '').replace(/```$/i, '').trim();
        await (0, audit_1.auditAction)(ctx, { action: 'GEN_LLM', targetType: 'data_source', targetId: ds.id, detail: { prompt: input.prompt } });
        return { mode: 'llm', sql, understanding: '已根据元数据生成查询', tables: catalog.map((t) => t.table) };
    }
    catch (e) {
        // 降级手工模式：不阻塞平台（REQ-GEN-09）
        await (0, audit_1.auditAction)(ctx, { action: 'GEN_DEGRADE', targetType: 'data_source', targetId: ds.id, detail: { error: e instanceof Error ? e.message : 'unknown' } });
        return { mode: 'manual', sql: null, reason: e instanceof Error ? e.message : '生成失败' };
    }
}
