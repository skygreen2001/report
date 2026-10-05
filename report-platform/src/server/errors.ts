// 统一错误结构：{ code, message, traceId }（doc §5）。message 不泄露 SQL/堆栈/连接串。

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
    this.name = 'HttpError';
  }
}

// SQL 网关拒绝：携带规则编号（对应 REQ-SEC-01~05）
export class SqlReject extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
    this.name = 'SqlReject';
  }
}

// 业务库返回的 MySQL 错误码 → 平台错误码。
// 目的：表不存在/列名写错/没权限这类「用户可修正」的问题走 400 并给出明确编号，
// 而不是笼统的 500 INTERNAL 把 MySQL 原始报文丢出去。
const DB_ERROR_MAP: Record<number, string> = {
  1146: 'TABLE_NOT_FOUND',   // ER_NO_SUCH_TABLE
  1051: 'TABLE_NOT_FOUND',   // ER_BAD_TABLE_ERROR
  1109: 'TABLE_NOT_FOUND',   // ER_UNKNOWN_TABLE
  1054: 'COLUMN_NOT_FOUND',  // ER_BAD_FIELD_ERROR
  1064: 'SQL_SYNTAX_ERROR',  // ER_PARSE_ERROR
  1049: 'DB_NOT_FOUND',      // ER_BAD_DB_ERROR
  1044: 'DB_ACCESS_DENIED',  // ER_DBACCESS_DENIED_ERROR
  1045: 'DB_ACCESS_DENIED',  // ER_ACCESS_DENIED_ERROR
  1142: 'DB_ACCESS_DENIED',  // ER_TABLEACCESS_DENIED_ERROR
  3024: 'QUERY_TIMEOUT',     // ER_QUERY_INTERRUPTED（max_execution_time 触发）
  1317: 'QUERY_TIMEOUT',     // ER_MAX_EXECUTION_TIME_EXCEEDED
  1040: 'DB_BUSY',           // ER_CON_COUNT_ERROR：连接数打满
  1203: 'DB_BUSY',           // ER_TOO_MANY_USER_CONNECTIONS
};

// 把 mysql2 抛出的错误翻译成 SqlReject；不认识的返回 undefined（仍按 INTERNAL 处理）
export function mapDbError(e: unknown): SqlReject | undefined {
  const errno = (e as { errno?: number } | null)?.errno;
  if (typeof errno === 'number' && DB_ERROR_MAP[errno]) {
    const code = DB_ERROR_MAP[errno];
    const raw = e instanceof Error ? e.message : '';
    return new SqlReject(code, raw ? `${code} — ${raw}` : code);
  }
  return undefined;
}

export interface ErrorBody {
  code: string;
  message: string;
  traceId: string;
}

// zod 原生英文提示 → 中文（前端直接展示给开发者，别甩英文堆栈）
function humanizeZodMessage(msg?: string): string {
  if (!msg) return '参数不合法';
  if (/received null/.test(msg)) return '不能为 null（不传该字段，或传字符串）';
  if (/received undefined|Required/.test(msg)) return '必填';
  if (/received number/.test(msg)) return '应为字符串';
  if (/received string/.test(msg)) return '应为数字';
  if (/at least/i.test(msg)) return '内容太短，不满足最小长度';
  if (/at most|too_big/i.test(msg)) return '内容太长，超出最大长度';
  if (/Invalid enum|invalid_enum/i.test(msg)) return '取值不在允许范围内';
  if (/regex/i.test(msg)) return '格式不合法（只允许字母、数字、下划线、连字符）';
  return msg;
}

export function toErrorResponse(e: unknown, role: 'CLIENT' | 'DEVELOPER'): { status: number; body: ErrorBody } {
  const traceId = randomTrace();
  if (e instanceof HttpError) {
    return { status: e.status, body: { code: e.code, message: e.code, traceId } };
  }
  if (e instanceof SqlReject) {
    // 规则编号本身可展示；开发者额外拿到明细（如表名/列名），甲方只见编号。
    // 注意：绝不回显 SQL 文本。
    return { status: 400, body: { code: e.code, message: role === 'DEVELOPER' ? e.message : e.code, traceId } };
  }
  // zod 校验失败：400（这里不 import zod，用鸭子类型判定，避免 Edge/Node 双运行时耦合）
  if (e && typeof e === 'object' && (e as { name?: string }).name === 'ZodError') {
    const first = (e as { issues?: { path?: (string | number)[]; message?: string }[] }).issues?.[0];
    const field = first?.path?.join('.') ?? '';
    const detail = humanizeZodMessage(first?.message);
    return {
      status: 400,
      body: { code: 'VALIDATION_ERROR', message: field ? `${field}: ${detail}` : detail, traceId },
    };
  }
  // 未知错误：甲方只看到「系统错误」，开发者看明细（REQ-NFR-06、REQ-SEC-11）
  const detail = e instanceof Error ? e.message : 'internal';
  return {
    status: 500,
    body: {
      code: 'INTERNAL',
      message: role === 'CLIENT' ? '系统错误，请稍后重试' : detail,
      traceId,
    },
  };
}

export function randomTrace(): string {
  // 避免 Edge 环境无 crypto.randomUUID 的隐患（本模块跑在 Node runtime）
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}
