// 参数映射（字典）：开发者为参数定义「中文标签 → 数据库值」的选项，
// 甲方端只看到中文下拉；提交的是 label，在此统一转成数据库 value 后才进
// prepared statement——服务端是映射的唯一权威，防止绕过前端直接提交编码/伪造值。
import { HttpError } from '../errors';

export interface ParamOption {
  label: string; // 甲方看到的中文（如「好」）
  value: string; // 实际送进 SQL 的值（如「1」）
}
export interface ParamDef {
  name: string;
  label: string;
  type: string;
  required: boolean;
  options?: ParamOption[]; // 有 options = 甲方端渲染下拉，且必须按映射转换
}

// 宽松解析（展示/执行用）：坏数据与旧格式（无 options）安全回落，不抛错
export function parseParamSchema(json: string | null | undefined): ParamDef[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((p: any) => p && typeof p.name === 'string')
      .map((p: any) => {
        const def: ParamDef = {
          name: p.name,
          label: typeof p.label === 'string' && p.label ? p.label : p.name,
          type: typeof p.type === 'string' ? p.type : 'string',
          required: p.required !== false,
        };
        const clean = (Array.isArray(p.options) ? p.options : [])
          .filter((o: any) => o && typeof o.label === 'string' && o.label !== '' && typeof o.value === 'string' && o.value !== '')
          .map((o: any) => ({ label: o.label, value: o.value }));
        if (clean.length) def.options = clean;
        return def;
      });
  } catch {
    return [];
  }
}

// 保存前严格校验 + 规范化：返回可直接入库的 JSON 字符串；无参数返回 null
export function normalizeParamSchemaJson(json: string | null | undefined): string | null {
  if (!json || !json.trim()) return null;
  let arr: any;
  try {
    arr = JSON.parse(json);
  } catch {
    throw new HttpError(400, 'PARAM_SCHEMA_INVALID', '参数定义格式不正确');
  }
  if (!Array.isArray(arr)) throw new HttpError(400, 'PARAM_SCHEMA_INVALID', '参数定义格式不正确');
  const out: ParamDef[] = [];
  const seenName = new Set<string>();
  for (const p of arr) {
    if (!p || typeof p.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.name)) {
      throw new HttpError(400, 'PARAM_SCHEMA_INVALID', `参数名「${p?.name ?? ''}」不合法（字母/数字/下划线）`);
    }
    if (seenName.has(p.name)) throw new HttpError(400, 'PARAM_SCHEMA_INVALID', `参数名「${p.name}」重复`);
    seenName.add(p.name);
    const def: ParamDef = {
      name: p.name,
      label: typeof p.label === 'string' && p.label.trim() ? p.label.trim() : p.name,
      type: 'string',
      required: true,
    };
    if (p.options !== undefined && p.options !== null) {
      if (!Array.isArray(p.options)) throw new HttpError(400, 'PARAM_SCHEMA_INVALID', `参数「${p.name}」的选项格式不正确`);
      const seenLabel = new Set<string>();
      const opts: ParamOption[] = [];
      for (const o of p.options) {
        if (!o || typeof o.label !== 'string' || !o.label.trim() || typeof o.value !== 'string' || !o.value.trim()) {
          throw new HttpError(400, 'PARAM_SCHEMA_INVALID', `参数「${p.name}」的选项需要同时填写「显示名」和「数据库值」`);
        }
        const label = o.label.trim();
        if (seenLabel.has(label)) throw new HttpError(400, 'PARAM_SCHEMA_INVALID', `参数「${p.name}」的显示名「${label}」重复`);
        seenLabel.add(label);
        opts.push({ label, value: o.value.trim() });
      }
      if (opts.length) def.options = opts; // 空数组视为「无映射」，保持输入框形态
    }
    out.push(def);
  }
  return out.length ? JSON.stringify(out) : null;
}

// 映射：把甲方提交的 label 换成数据库 value。
// - 有 options 的参数：值必须命中某个 label，否则 400（防伪造/防直接提交编码）
// - 无 options 的参数：原样透传（输入框形态）
// - 空值不映射：交给 bindValues 的 PARAM_MISSING 提示，保持原有错误文案
export function resolveParams(defs: ParamDef[], params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...params };
  for (const d of defs) {
    if (!d.options?.length) continue;
    const v = params[d.name];
    if (v === undefined || v === null || v === '') continue;
    const hit = d.options.find((o) => o.label === v);
    if (!hit) {
      throw new HttpError(400, 'PARAM_INVALID', `参数「${d.label || d.name}」的值「${String(v)}」不在可选范围内，请从下拉框选择`);
    }
    out[d.name] = hit.value;
  }
  return out;
}
