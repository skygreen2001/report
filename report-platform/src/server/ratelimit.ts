// 进程内令牌桶限流（doc §1）。按 (appId, clientKey, 维度) 限流，单机够用。
// 对应 REQ-SEC-07：预览/生成 30 次/分钟/clientKey。
import { HttpError } from './errors';

interface Bucket {
  tokens: number;
  updated: number;
}

const buckets = new Map<string, Bucket>();

export function rateLimit(key: string, max: number, windowMs: number): void {
  const now = Date.now();
  const b = buckets.get(key);
  const refill = max / windowMs; // 每秒补充
  if (!b) {
    buckets.set(key, { tokens: max - 1, updated: now });
    return;
  }
  const elapsed = now - b.updated;
  b.tokens = Math.min(max, b.tokens + elapsed * refill);
  b.updated = now;
  if (b.tokens < 1) {
    throw new HttpError(429, 'RATE_LIMITED');
  }
  b.tokens -= 1;
}

