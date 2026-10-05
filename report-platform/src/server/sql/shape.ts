// ⑤ Shape：敏感列脱敏（doc §8.3、REQ-SEC-09）。预览与导出一致，脱敏结果写入审计（不写明文）。
import crypto from 'node:crypto';
import type { SensitiveColumn } from '@/lib/types';

function mask(v: string): string {
  const s = String(v);
  if (s.length <= 2) return '*'.repeat(s.length);
  return s.slice(0, 2) + '*'.repeat(Math.min(s.length - 2, 8));
}

function hash(v: string): string {
  return crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 12);
}

// 按列名应用脱敏策略（数据源自带 sensitive_columns_json）
export function applyShape(rows: Record<string, unknown>[], rules: SensitiveColumn[] | null): Record<string, unknown>[] {
  if (!rules || !rules.length || !rows.length) return rows;
  const byCol = new Map(rules.map((r) => [r.column.toLowerCase(), r]));
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const key of Object.keys(out)) {
      const rule = byCol.get(key.toLowerCase());
      if (rule && out[key] != null) {
        out[key] = rule.strategy === 'hash' ? hash(String(out[key])) : mask(String(out[key]));
      }
    }
    return out;
  });
}

export function parseSensitive(json: string | null): SensitiveColumn[] | null {
  if (!json) return null;
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}
