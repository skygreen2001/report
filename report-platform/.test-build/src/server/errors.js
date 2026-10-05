"use strict";
// 统一错误结构：{ code, message, traceId }（doc §5）。message 不泄露 SQL/堆栈/连接串。
Object.defineProperty(exports, "__esModule", { value: true });
exports.SqlReject = exports.HttpError = void 0;
exports.mapDbError = mapDbError;
exports.toErrorResponse = toErrorResponse;
exports.randomTrace = randomTrace;
class HttpError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message ?? code);
        this.status = status;
        this.code = code;
        this.name = 'HttpError';
    }
}
exports.HttpError = HttpError;
// SQL 网关拒绝：携带规则编号（对应 REQ-SEC-01~05）
class SqlReject extends Error {
    code;
    constructor(code, message) {
        super(message ?? code);
        this.code = code;
        this.name = 'SqlReject';
    }
}
exports.SqlReject = SqlReject;
// 业务库返回的 MySQL 错误码 → 平台错误码。
// 目的：表不存在/列名写错/没权限这类「用户可修正」的问题走 400 并给出明确编号，
// 而不是笼统的 500 INTERNAL 把 MySQL 原始报文丢出去。
const DB_ERROR_MAP = {
    1146: 'TABLE_NOT_FOUND', // ER_NO_SUCH_TABLE
    1051: 'TABLE_NOT_FOUND', // ER_BAD_TABLE_ERROR
    1109: 'TABLE_NOT_FOUND', // ER_UNKNOWN_TABLE
    1054: 'COLUMN_NOT_FOUND', // ER_BAD_FIELD_ERROR
    1064: 'SQL_SYNTAX_ERROR', // ER_PARSE_ERROR
    1049: 'DB_NOT_FOUND', // ER_BAD_DB_ERROR
    1044: 'DB_ACCESS_DENIED', // ER_DBACCESS_DENIED_ERROR
    1045: 'DB_ACCESS_DENIED', // ER_ACCESS_DENIED_ERROR
    1142: 'DB_ACCESS_DENIED', // ER_TABLEACCESS_DENIED_ERROR
    3024: 'QUERY_TIMEOUT', // ER_QUERY_INTERRUPTED（max_execution_time 触发）
    1317: 'QUERY_TIMEOUT', // ER_MAX_EXECUTION_TIME_EXCEEDED
    1040: 'DB_BUSY', // ER_CON_COUNT_ERROR：连接数打满
    1203: 'DB_BUSY', // ER_TOO_MANY_USER_CONNECTIONS
};
// 把 mysql2 抛出的错误翻译成 SqlReject；不认识的返回 undefined（仍按 INTERNAL 处理）
function mapDbError(e) {
    const errno = e?.errno;
    if (typeof errno === 'number' && DB_ERROR_MAP[errno]) {
        const code = DB_ERROR_MAP[errno];
        const raw = e instanceof Error ? e.message : '';
        return new SqlReject(code, raw ? `${code} — ${raw}` : code);
    }
    return undefined;
}
function toErrorResponse(e, role) {
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
    if (e && typeof e === 'object' && e.name === 'ZodError') {
        const first = e.issues?.[0];
        const field = first?.path?.join('.') ?? '';
        return {
            status: 400,
            body: { code: 'VALIDATION_ERROR', message: field ? `${field}: ${first?.message ?? '参数不合法'}` : '参数不合法', traceId },
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
function randomTrace() {
    // 避免 Edge 环境无 crypto.randomUUID 的隐患（本模块跑在 Node runtime）
    return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}
