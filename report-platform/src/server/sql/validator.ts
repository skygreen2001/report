// ② 校验：白名单 SELECT/WITH + 黑名单关键字/函数/系统库（doc §6.2）。§15.2 校正已并入。
import { SqlReject } from '../errors';

// 危险函数（§6.2 + §12 对抗清单）
const DANGEROUS_FN = new Set([
  'SLEEP', 'BENCHMARK', 'LOAD_FILE', 'INTO_OUTFILE', 'INTO_DUMPFILE', 'GET_LOCK',
  'RELEASE_LOCK', 'IS_FREE_LOCK', 'SYS_EXEC', 'SYS_EVAL', 'UUID_SHORT', 'MASTER_POS_WAIT',
  'NAME_CONST', 'GEOMETRYCOLLECTION', 'RLIKE',
]);

const BLOCKED_SCHEMA = new Set(['mysql', 'sys', 'performance_schema', 'information_schema']);
// 仅放行只读语句。WITH...SELECT 根类型为 select；若解析器给出 with 也放行（CTE 查询）。
const STMT_WHITELIST = new Set(['select', 'with']);

function normalizeFnName(name: any): string {
  if (!name) return '';
  if (typeof name === 'string') return name;
  if (Array.isArray(name?.name)) return String(name.name[0]?.value ?? '');
  if (typeof name?.value === 'string') return name.value;
  return '';
}

// 通用 AST 遍历（避免循环引用导致死循环）
function walk(node: any, cb: (n: any) => void) {
  const seen = new WeakSet<object>();
  const rec = (n: any) => {
    if (n == null || typeof n !== 'object') return;
    if (seen.has(n)) return;
    seen.add(n);
    cb(n);
    for (const k of Object.keys(n)) {
      const v = (n as any)[k];
      if (Array.isArray(v)) v.forEach(rec);
      else if (v && typeof v === 'object') rec(v);
    }
  };
  rec(node);
}

export function validate(ast: any, rawSql: string, allowedSchemas: string[]): void {
  // ① 主语句类型：必须只读（REQ-SEC-01）。校验 AST 根节点类型，不只看开头关键字。
  const rootType = String(ast?.type ?? '').toLowerCase();
  if (!STMT_WHITELIST.has(rootType)) {
    throw new SqlReject('STMT_NOT_READONLY', `语句类型 ${ast?.type} 不被允许`);
  }

  // ② 递归收集函数调用与表引用
  const fns: string[] = [];
  const tables: Array<{ db?: string; table: string }> = [];
  walk(ast, (n: any) => {
    if (n && n.type === 'function') {
      const fn = normalizeFnName(n.name);
      if (fn) fns.push(fn.toUpperCase());
    }
    if (n && typeof n.table === 'string') {
      tables.push({ db: n.db ?? n.schema, table: n.table });
    }
  });

  for (const f of fns) {
    if (DANGEROUS_FN.has(f)) throw new SqlReject('DANGEROUS_FUNCTION', `禁止使用函数 ${f}`);
  }

  // ③ 库范围：系统库优先拒绝，再校验是否在允许列表（REQ-SEC-02）
  for (const t of tables) {
    if (t.db && BLOCKED_SCHEMA.has(t.db.toLowerCase())) {
      throw new SqlReject('SYSTEM_SCHEMA', '不允许访问系统库');
    }
    if (t.db && !allowedSchemas.includes(t.db)) {
      throw new SqlReject('SCHEMA_NOT_ALLOWED', `不允许访问库 ${t.db}`);
    }
  }

  // ④ 深度防御：可执行注释直接拒；再剥离注释/字符串后扫危险关键字（§15.2 修正2）
  deepScan(rawSql);

  // ⑤ 行数与超时由 executor 二次硬截断（REQ-SEC-03）
}

// 深度扫描：先拒可执行注释，再按固定顺序去注释→去字符串→扫关键字（顺序不能反，§6.2）
function deepScan(sql: string): void {
  // ★ 见到 /*! 直接拒绝（可执行注释，MySQL 会真的执行其中代码）
  if (/\/\*!/.test(sql)) throw new SqlReject('DEEP_SCAN_BLOCK', '禁止可执行注释 /*!');

  let s = sql;
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' '); // 块注释
  s = s.replace(/--[^\n]*/g, ' ');          // -- 注释（MySQL 要求 -- 后空格）
  s = s.replace(/#.*$/gm, ' ');            // # 注释
  s = s.replace(/'(?:''|\\.|[^'\\])*'/g, "''"); // 单引号字符串
  s = s.replace(/"(?:""|\\.|[^"\\])*"/g, '""'); // 双引号字符串（受 ANSI_QUOTES 影响）

  const hit = [
    [/\b(INSERT|UPDATE|DELETE|REPLACE|MERGE|TRUNCATE)\b/i, 'DML'],
    [/\b(CREATE|ALTER|DROP|RENAME|GRANT|REVOKE|SET|CALL|LOCK|UNLOCK)\b/i, 'DDL_TCL'],
    [/\b(INTO\s+OUTFILE|INTO\s+DUMPFILE|LOAD_FILE)\b/i, 'FILE_ACCESS'],
    [/\b(SLEEP|BENCHMARK|GET_LOCK|SYS_EXEC|SYS_EVAL)\b/i, 'DANGEROUS_FUNCTION'],
    [/\b(mysql|sys|performance_schema)\s*\./i, 'SYSTEM_SCHEMA'],
  ].find(([re]) => (re as RegExp).test(s));

  if (hit) throw new SqlReject('DEEP_SCAN_BLOCK', `命中规则 ${hit[1]}`);
}
