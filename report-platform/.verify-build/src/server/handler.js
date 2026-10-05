"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withRole = withRole;
exports.json = json;
// 路由封装：解析 RoleContext + 统一错误映射（doc §5 统一错误结构）。
const context_1 = require("./context");
const errors_1 = require("./errors");
async function withRole(req, fn) {
    let ctx;
    try {
        ctx = await (0, context_1.resolveContext)(req);
    }
    catch (e) {
        // 解析失败时尚不知角色，按 CLIENT 处理（信息最小化）
        const { status, body } = (0, errors_1.toErrorResponse)(e, 'CLIENT');
        return Response.json(body, { status });
    }
    try {
        return await fn(ctx, req);
    }
    catch (e) {
        // 已确定角色：开发者可见错误明细，甲方只看到「系统错误」（REQ-NFR-06、REQ-SEC-11）
        const { status, body } = (0, errors_1.toErrorResponse)(e, ctx.role);
        return Response.json(body, { status });
    }
}
function json(data, status = 200) {
    return Response.json(data, { status });
}
