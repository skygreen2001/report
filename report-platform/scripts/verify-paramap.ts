// 参数映射（字典）端到端验证：单测边界 + API 级 label→value 转换与防伪造
const BASE = 'http://127.0.0.1:3111';
const WS = 'ff20a6ac3a9546c38e';
const API = `${BASE}/platform/d/api`;
const CAPI = `${BASE}/platform/c/api`;
const DS = '5316d17a-8eb2-4f84-9941-49356db4d591'; // localhost / biz_demo / report_ro

let pass = 0, fail = 0;
function ok(cond: boolean, name: string, extra = '') {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.log(`✗ ${name} ${extra}`); }
}

async function main() {
// ---------- ① 单测：normalizeParamSchemaJson / resolveParams ----------
const { normalizeParamSchemaJson, resolveParams, parseParamSchema } = await import('@/server/services/paramMap');

ok(normalizeParamSchemaJson(null) === null, 'null schema → null');
ok(normalizeParamSchemaJson('') === null, '空串 → null');
try { normalizeParamSchemaJson('{bad'); ok(false, '坏 JSON 应 400'); }
catch (e: any) { ok(e.code === 'PARAM_SCHEMA_INVALID' || e.status === 400, '坏 JSON → 400 PARAM_SCHEMA_INVALID'); }
try { normalizeParamSchemaJson('[{"name":"a b"}]'); ok(false, '非法参数名应 400'); }
catch (e: any) { ok(e.status === 400, '非法参数名 → 400'); }
try { normalizeParamSchemaJson('[{"name":"a"},{"name":"a"}]'); ok(false, '重复参数名应 400'); }
catch (e: any) { ok(e.status === 400, '重复参数名 → 400'); }
try { normalizeParamSchemaJson('[{"name":"a","options":[{"label":"好","value":""}]}]'); ok(false, '选项缺 value 应 400'); }
catch (e: any) { ok(e.status === 400, '选项缺 value → 400'); }
try { normalizeParamSchemaJson('[{"name":"a","options":[{"label":"好","value":"1"},{"label":"好","value":"2"}]}]'); ok(false, '选项 label 重复应 400'); }
catch (e: any) { ok(e.status === 400, '选项 label 重复 → 400'); }
ok(normalizeParamSchemaJson('[{"name":"a","options":[]}]') === '[{"name":"a","label":"a","type":"string","required":true}]', '空 options 回落为无映射');
const norm = normalizeParamSchemaJson('[{"name":"status","options":[{"label":"好","value":"1"}]}]');
ok(norm === '[{"name":"status","label":"status","type":"string","required":true,"options":[{"label":"好","value":"1"}]}]', '规范化输出含 options', String(norm));

const defs = parseParamSchema('[{"name":"status","label":"订单状态","options":[{"label":"好","value":"1"},{"label":"还行","value":"2"}]},{"name":"start_date","label":"起始日期"}]');
const m1 = resolveParams(defs, { status: '好', start_date: '2026-09-01' });
ok(m1.status === '1' && m1.start_date === '2026-09-01', 'label→value 映射，无映射参数透传', JSON.stringify(m1));
try { resolveParams(defs, { status: '1' }); ok(false, '直接提交编码应 400'); }
catch (e: any) { ok(e.status === 400 && e.code === 'PARAM_INVALID', '伪造 value → 400 PARAM_INVALID', e.code); }
const m2 = resolveParams(defs, { status: '', start_date: '2026-09-01' });
ok(m2.status === '', '空值不映射（交给 PARAM_MISSING 提示）');

// ---------- ② API 级：创建带映射报表 → 甲方查询 ----------
const SCHEMA = JSON.stringify([
  { name: 'status', label: '订单状态', type: 'string', required: true, options: [
    { label: '已支付', value: 'PAID' }, { label: '待支付', value: 'PENDING' }, { label: '已退款', value: 'REFUNDED' },
  ] },
  { name: 'start_date', label: '起始日期', type: 'string', required: true },
]);
const createRes = await fetch(`${API}/reports?ws=${WS}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: `订单明细（映射验证 ${Date.now()}）`,
    sqlText: 'SELECT id, customer_name AS customer, region, amount, status, created_at\nFROM orders\nWHERE status = {{status}}\n  AND created_at >= {{start_date}}\nORDER BY created_at DESC',
    dataSourceId: DS,
    paramsSchemaJson: SCHEMA,
  }),
});
const created = await createRes.json();
ok(createRes.ok && !!created.id, '创建带映射报表', JSON.stringify(created));
const rid = created.id;
try {

// 甲方选「已支付」→ 服务端应映射为 PAID（结果行 status 列全为 PAID）
const prev = await fetch(`${CAPI}/reports/preview?ws=${WS}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ reportId: rid, params: { status: '已支付', start_date: '2026-09-01' } }),
});
const pv = await prev.json();
ok(prev.ok && Array.isArray(pv.rows), '映射后预览成功');
ok(pv.rows.length > 0 && pv.rows.every((r: any) => r.status === 'PAID'), '结果全部 status=PAID（映射生效）', `rows=${pv.rows?.length}`);

// 伪造：直接提交编码 → 400
const fake = await fetch(`${CAPI}/reports/preview?ws=${WS}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ reportId: rid, params: { status: 'PAID', start_date: '2026-09-01' } }),
});
const fv = await fake.json();
ok(fake.status === 400 && fv.code === 'PARAM_INVALID', '直接提交编码被拒（400 PARAM_INVALID）', JSON.stringify(fv));

// 缺参数 → 原有 PARAM_MISSING 行为不变
const miss = await fetch(`${CAPI}/reports/preview?ws=${WS}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ reportId: rid, params: { status: '待支付' } }),
});
ok(miss.status === 400, '缺 start_date → 400', String(miss.status));

// 「全部」分页也走映射
const all = await fetch(`${CAPI}/reports/all?ws=${WS}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ reportId: rid, params: { status: '已退款', start_date: '2026-01-01' }, page: 1, pageSize: 10 }),
});
const av = await all.json();
ok(all.ok && av.total > 0 && av.rows.every((r: any) => r.status === 'REFUNDED'), '「全部」模式映射生效（REFUNDED）', `total=${av.total}`);

// 保存时坏 schema 被拒
const badSave = await fetch(`${API}/reports?ws=${WS}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: '坏映射', sqlText: 'SELECT 1 FROM orders LIMIT 1', dataSourceId: DS, paramsSchemaJson: '[{"name":"a","options":[{"label":"好"}]}]' }),
});
ok(badSave.status === 400, '保存时坏 schema → 400', String(badSave.status));

// 清理验证报表（移入回收站即从列表消失；唯一键占用随之保留在回收站内）
await fetch(`${API}/reports/${rid}/delete?ws=${WS}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
} finally {
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
}
}
main();
