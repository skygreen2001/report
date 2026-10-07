// NL2SQL 生成（doc §5、§17.7）。出网仅含元数据+提示词+当前模板；失败降级手工模式(REQ-GEN-09)。
import OpenAI from 'openai';
import { loadDataSource, getCatalog } from './datasource';
import { resolveProvider } from './llm';
import { presetOf } from '@/lib/llm-presets';
import { auditAction } from './audit';
import { HttpError } from '../errors';
import type { RoleContext } from '@/lib/types';

export interface GenerateInput {
  prompt: string;
  dataSourceId: string;
  currentSql?: string; // 协作：开发者在已有 SQL 基础上改
  providerId?: string | null; // 指定模型；不传用应用默认
}

export interface GenerateResult {
  mode: 'llm' | 'manual';
  sql: string | null;
  understanding?: string; // 理解说明 + 用到的表字段（不展示 SQL 全文给甲方）
  tables?: string[];
  reason?: string; // 降级原因
  noModel?: boolean; // true=本角色未配置任何模型（应把需求交给开发者）；false=模型存在但生成失败
}

const SYS_PROMPT = '你是企业报表平台的 SQL 生成助手。只输出一条 MySQL SELECT（或 WITH...SELECT）只读查询，禁止任何写操作、禁止系统库、禁止 INTO OUTFILE、禁止 SLEEP 等危险函数。参数用 {{name}} 占位（仅值位置）。只返回 SQL，不要解释。';

// 出网内容仅含元数据（表名/列名/注释）+ 用户提示词，不含任何业务数据（doc §17.7）
function buildUserPrompt(prompt: string, catalog: any[], currentSql?: string): string {
  const meta = catalog
    .map((t) => `表 ${t.table}: ${(t.columns ?? []).map((c: any) => c.column_name).join(', ')}`)
    .join('\n');
  return `可用元数据：\n${meta}\n\n用户需求：${prompt}${currentSql ? `\n\n当前 SQL（在此基础上修改）：\n${currentSql}` : ''}`;
}

function buildClient(endpoint: string, apiKey: string) {
  return new OpenAI({ apiKey, baseURL: endpoint, timeout: 20_000 });
}

export async function generateSql(ctx: RoleContext, input: GenerateInput): Promise<GenerateResult> {
  const ds = await loadDataSource(input.dataSourceId);
  // 模型优先级：本次指定 > 应用默认（llm_provider）> 应用 settings.llm > 环境变量
  const p = await resolveProvider(ctx, input.providerId);

  // 本角色一个模型都没配：降级为手工模式，并把需求交给开发者
  if (!p) {
    const hint = ctx.role === 'CLIENT'
      ? '未配置可用模型（请到「模型配置」中添加你自己的模型）'
      : '未配置可用模型（开发者端 → 模型配置）';
    return { mode: 'manual', sql: null, reason: hint, noModel: true };
  }
  // 缺核心连接信息（只可能是用户手改过，正常新增必带）
  if (!p.endpoint || !p.model) {
    return { mode: 'manual', sql: null, reason: '模型缺少接口地址或模型名（请到「模型配置」补全）', noModel: false };
  }
  // 本地/自建模型（ollama/vllm/xinference/lmstudio）与自定义 OpenAI 兼容服务允许不填密钥；
  // 云端厂商（deepseek/qwen 等）必须有 key，否则明确提示缺 key，而不是误判「没模型」。
  const keyOptional = presetOf(p.vendor)?.local === true || p.vendor === 'custom';
  if (!keyOptional && !p.apiKey) {
    return { mode: 'manual', sql: null, reason: '该模型缺少 API Key（请到「模型配置」补全密钥）', noModel: false };
  }
  const endpoint = p.endpoint;
  const apiKey = p.apiKey || 'EMPTY'; // 本地模型无需 key，与 testProvider 一致
  const model = p.model;

  const catalog = await getCatalog(ds);

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

    await auditAction(ctx, { action: 'GEN_LLM', targetType: 'data_source', targetId: ds.id, detail: { prompt: input.prompt, model, provider: p.id || 'env' } });
    return { mode: 'llm', sql, understanding: `已根据元数据生成查询（模型：${p.name} / ${model}）`, tables: catalog.map((t) => t.table) };
  } catch (e) {
    // 降级手工模式：不阻塞平台（REQ-GEN-09）
    await auditAction(ctx, { action: 'GEN_DEGRADE', targetType: 'data_source', targetId: ds.id, detail: { error: e instanceof Error ? e.message : 'unknown' } });
    return { mode: 'manual', sql: null, reason: e instanceof Error ? e.message : '生成失败' };
  }
}
