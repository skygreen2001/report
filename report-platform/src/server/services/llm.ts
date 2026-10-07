// 模型服务商配置（国内主流厂商 + 本地自建模型，统一 OpenAI 兼容协议）。
// 密钥一律 AES-256-GCM 加密入库，接口永不回显明文（只回 hasKey）。
import { pGet, pQuery, pRun } from '../db/platform';
import { encrypt, decrypt } from '../crypto';
import { HttpError } from '../errors';
import OpenAI from 'openai';
import crypto from 'node:crypto';
import type { RoleContext, LlmProviderRow } from '@/lib/types';

export interface ProviderInput {
  name: string;
  vendor?: string | null;
  endpoint: string;
  model: string;
  apiKey?: string | null; // 为空表示不改动（更新时）或不需要（本地模型）
  isDefault?: boolean;
}

// 列表：绝不带 api_key_enc（REQ-SEC：凭据不回显）。按 scope（角色）隔离——开发者只看见开发者的，甲方只看见甲方的。
export async function listProviders(appId: string, scope: 'DEVELOPER' | 'CLIENT', onlyActive = false): Promise<any[]> {
  const rows = await pQuery<LlmProviderRow>(
    `SELECT id,app_id,scope,name,vendor,endpoint,model,is_default,status,created_at,
            (api_key_enc IS NOT NULL AND api_key_enc <> '') AS has_key
     FROM llm_provider WHERE app_id=? AND scope=?${onlyActive ? " AND status='ACTIVE'" : ''}
     ORDER BY is_default DESC, created_at`,
    [appId, scope],
  );
  return rows.map((r: any) => ({ ...r, has_key: !!Number(r.has_key) }));
}

function normalizeEndpoint(raw: string): string {
  let e = raw.trim().replace(/\/+$/, '');
  // 各家文档写法不一：给了 .../v1/chat/completions 也能认，统一截到 /vN
  e = e.replace(/\/chat\/completions\/?$/, '');
  return e;
}

export async function createProvider(ctx: RoleContext, input: ProviderInput): Promise<string> {
  // 谁调谁拥有：开发者建的就是 DEVELOPER 作用域，甲方建的就是 CLIENT 作用域（各是各的配置）
  const scope = ctx.role;
  const id = crypto.randomUUID();
  const endpoint = normalizeEndpoint(input.endpoint);
  if (!endpoint) throw new HttpError(400, 'ENDPOINT_REQUIRED');
  if (!input.model?.trim()) throw new HttpError(400, 'MODEL_REQUIRED');
  await pRun(
    `INSERT INTO llm_provider (id,app_id,scope,name,vendor,endpoint,model,api_key_enc,is_default,status)
     VALUES (?,?,?,?,?,?,?,?,?, 'ACTIVE')`,
    [id, ctx.appId, scope, input.name, input.vendor ?? 'custom', endpoint, input.model.trim(),
      input.apiKey ? encrypt(input.apiKey) : null, input.isDefault ? 1 : 0],
  );
  if (input.isDefault) await setDefaultProvider(ctx, id);
  return id;
}

export async function updateProvider(ctx: RoleContext, id: string, input: Partial<ProviderInput> & { status?: 'ACTIVE' | 'DISABLED' }): Promise<void> {
  const row = await getProviderRow(ctx.appId, id, ctx.role); // 跨作用域 404
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.name !== undefined) { sets.push('name=?'); params.push(input.name); }
  if (input.vendor !== undefined) { sets.push('vendor=?'); params.push(input.vendor ?? 'custom'); }
  if (input.endpoint !== undefined) { sets.push('endpoint=?'); params.push(normalizeEndpoint(input.endpoint)); }
  if (input.model !== undefined) { sets.push('model=?'); params.push(input.model.trim()); }
  if (input.apiKey) { sets.push('api_key_enc=?'); params.push(encrypt(input.apiKey)); }
  if (input.status !== undefined) { sets.push('status=?'); params.push(input.status); }
  if (sets.length === 0) return;
  params.push(id, ctx.appId);
  await pRun(`UPDATE llm_provider SET ${sets.join(',')} WHERE id=? AND app_id=?`, params);
  if (input.isDefault) await setDefaultProvider(ctx, id);
}

export async function deleteProvider(ctx: RoleContext, id: string): Promise<void> {
  await getProviderRow(ctx.appId, id, ctx.role); // 跨作用域 404
  await pRun('DELETE FROM llm_provider WHERE id=? AND app_id=?', [id, ctx.appId]);
}

export async function setDefaultProvider(ctx: RoleContext, id: string): Promise<void> {
  const row = await getProviderRow(ctx.appId, id, ctx.role); // 跨作用域 404
  // 只清「同作用域」内的默认标记——开发者默认与甲方默认互不干扰
  await pRun('UPDATE llm_provider SET is_default=0 WHERE app_id=? AND scope=?', [ctx.appId, row.scope]);
  await pRun('UPDATE llm_provider SET is_default=1 WHERE id=? AND app_id=?', [id, ctx.appId]);
}

export async function getProviderRow(appId: string, id: string, scope?: 'DEVELOPER' | 'CLIENT'): Promise<LlmProviderRow> {
  const r = await pGet<LlmProviderRow>(
    scope ? 'SELECT * FROM llm_provider WHERE id=? AND app_id=? AND scope=?' : 'SELECT * FROM llm_provider WHERE id=? AND app_id=?',
    scope ? [id, appId, scope] : [id, appId],
  );
  if (!r) throw new HttpError(404, 'PROVIDER_NOT_FOUND');
  return r;
}

export interface ResolvedProvider {
  id: string;
  name: string;
  vendor: string;
  endpoint: string;
  model: string;
  apiKey: string;
}

// 生成 SQL 时取模型：显式指定 > 本角色默认 > 应用 settings.llm > 环境变量。
// 关键点：必须按 scope=ctx.role 过滤——甲方生成用甲方的模型，开发者用开发者的，各是各的配置。
export async function resolveProvider(ctx: RoleContext, providerId?: string | null): Promise<ResolvedProvider | null> {
  let row: LlmProviderRow | undefined;
  if (providerId) {
    row = await pGet<LlmProviderRow>(
      `SELECT * FROM llm_provider WHERE id=? AND app_id=? AND scope=? AND status='ACTIVE'`, [providerId, ctx.appId, ctx.role],
    );
    if (!row) throw new HttpError(404, 'PROVIDER_NOT_FOUND');
  } else {
    row = await pGet<LlmProviderRow>(
      `SELECT * FROM llm_provider WHERE app_id=? AND scope=? AND status='ACTIVE' ORDER BY is_default DESC, created_at LIMIT 1`,
      [ctx.appId, ctx.role],
    );
  }
  if (row) {
    return {
      id: row.id,
      name: row.name,
      vendor: row.vendor,
      endpoint: row.endpoint,
      model: row.model,
      apiKey: row.api_key_enc ? decrypt(row.api_key_enc) : '',
    };
  }
  // 没有任何「本角色自己配置」的模型：返回 null，由上层降级为手工模式 / 把需求交给开发者。
  // 不再回落到环境变量里的密钥——避免复用任何硬编码的 key，也保证「无模型时把需求交给开发者」的语义。
  return null;
}

// 连通性测试：发一条极短对话（不携带任何业务数据）
export async function testProvider(row: LlmProviderRow, plainKeyOverride?: string): Promise<{ ok: boolean; message: string; detail?: string }> {
  const apiKey = plainKeyOverride ?? (row.api_key_enc ? decrypt(row.api_key_enc) : '');
  try {
    const client = new OpenAI({ apiKey: apiKey || 'EMPTY', baseURL: row.endpoint, timeout: 15_000, maxRetries: 0 });
    const r = await client.chat.completions.create({
      model: row.model,
      messages: [{ role: 'user', content: 'reply OK' }],
      max_tokens: 8,
      temperature: 0,
    });
    const text = r.choices[0]?.message?.content?.trim() ?? '';
    return { ok: true, message: `连通成功 · 模型回复：${text.slice(0, 40) || '（空）'}` };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    // 判定顺序：先网络、再鉴权、再模型名（openai SDK 会把连接错误包成 Connection error）
    if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|ETIMEDOUT|socket hang up|Connection error|timeout/i.test(msg)) {
      return { ok: false, message: `连通失败：连不上 ${row.endpoint}（地址不通，或本地模型没启动）` };
    }
    if (/401|403|Unauthorized|invalid api key|authentication|incorrect API key/i.test(msg)) {
      return { ok: false, message: '连通失败：密钥无效或无权访问（401/403）' };
    }
    if (/404|not found|does not exist|unknown model|no such model|invalid model/i.test(msg)) {
      return { ok: false, message: `连通失败：模型名「${row.model}」在该服务上不可用` };
    }
    return { ok: false, message: `连通失败：${msg.slice(0, 160)}`, detail: msg.slice(0, 300) };
  }
}
