// 进程内 TTL 缓存（doc §1：单机部署够用；接口可替换，将来换 Redis）。
// 用于 application 解析（60s 缓存，REQ-ACC-03/07）。

interface Entry<T> {
  value: T;
  expires: number;
}

const store = new Map<string, Entry<unknown>>();

export function cacheGet<T>(key: string): T | undefined {
  const e = store.get(key);
  if (!e) return undefined;
  if (Date.now() > e.expires) {
    store.delete(key);
    return undefined;
  }
  return e.value as T;
}

export function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  store.set(key, { value, expires: Date.now() + ttlMs });
}

export function cacheDelete(key: string): void {
  store.delete(key);
}

// 按后缀批量失效：应用缓存的 key 里带的是「请求 host」，而库里存的可能是 ''（通配），
// 两者对不上，所以失效时必须按 path_prefix 后缀扫一遍，否则改了设置要等 TTL 才生效。
export function cacheDeleteBySuffix(suffix: string): void {
  for (const k of Array.from(store.keys())) {
    if (k.endsWith(suffix)) store.delete(k);
  }
}
