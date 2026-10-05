"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyShape = applyShape;
exports.parseSensitive = parseSensitive;
// ⑤ Shape：敏感列脱敏（doc §8.3、REQ-SEC-09）。预览与导出一致，脱敏结果写入审计（不写明文）。
const node_crypto_1 = __importDefault(require("node:crypto"));
function mask(v) {
    const s = String(v);
    if (s.length <= 2)
        return '*'.repeat(s.length);
    return s.slice(0, 2) + '*'.repeat(Math.min(s.length - 2, 8));
}
function hash(v) {
    return node_crypto_1.default.createHash('sha256').update(String(v)).digest('hex').slice(0, 12);
}
// 按列名应用脱敏策略（数据源自带 sensitive_columns_json）
function applyShape(rows, rules) {
    if (!rules || !rules.length || !rows.length)
        return rows;
    const byCol = new Map(rules.map((r) => [r.column.toLowerCase(), r]));
    return rows.map((row) => {
        const out = { ...row };
        for (const key of Object.keys(out)) {
            const rule = byCol.get(key.toLowerCase());
            if (rule && out[key] != null) {
                out[key] = rule.strategy === 'hash' ? hash(String(out[key])) : mask(String(out[key]));
            }
        }
        return out;
    });
}
function parseSensitive(json) {
    if (!json)
        return null;
    try {
        const arr = JSON.parse(json);
        return Array.isArray(arr) ? arr : null;
    }
    catch {
        return null;
    }
}
