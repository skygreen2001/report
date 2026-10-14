// Edge 中间件（doc §2.2）：只做 rewrite + clientKey Cookie，不查库（无 TCP）。
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const seg = pathname.split('/').filter(Boolean);
  const appPath = seg[0];
  const roleSeg = seg[1];

  // /{appPath}/{c|d}/*  →  /tenant/{appPath}/{c|d}/*  （rewrite 目标不以 _ 开头，见 §15.2 修正1）
  if ((roleSeg === 'c' || roleSeg === 'd') && !pathname.startsWith('/tenant/')) {
    const rest = seg.slice(2).join('/');
    const url = req.nextUrl.clone();
    url.pathname = `/tenant/${appPath}/${roleSeg}${rest ? '/' + rest : ''}`;

    // rewrite 之后，路由处理器看到的 URL 已变成 /tenant/... ，
    // 因此把 appPath / role 显式放进请求头，避免下游再按路径猜（doc §2.2、§15.2 修正1）
    const headers = new Headers(req.headers);
    headers.set('x-app-path', appPath);
    headers.set('x-role', roleSeg);
    // 使用者身份：URL 带 ?ws=<key> 就沿用该身份（换设备/备份用），否则用浏览器 Cookie 里的身份。
    // 都没有 → 现场生成一个并设置 Cookie：每个浏览器天然拥有自己的私密工作区，无需登录、无需发链接。
    // 身份只是一个随机串（不含任何敏感信息），真正的配置仍存在服务器，按它隔离。
    const wsParam = req.nextUrl.searchParams.get('ws');
    const wsCookie = req.cookies.get('wsKey')?.value;
    const generated = !wsParam && !wsCookie;
    const wsKey: string = wsParam ?? wsCookie ?? crypto.randomUUID().replace(/-/g, '').slice(0, 18);
    headers.set('x-ws', wsKey);
    // 只有「中间件现场生成」的身份才允许认领存量工作区；
    // 用户自己带 ?ws= 的链接表示"我要用这个身份"，即便库里没有也只新建一个，绝不抢占别人的配置。
    if (generated) headers.set('x-ws-generated', '1');
    const res = NextResponse.rewrite(url, { request: { headers } });
    if (generated || (wsParam && wsParam !== wsCookie)) {
      res.cookies.set('wsKey', wsKey, { httpOnly: true, sameSite: 'lax', path: '/' });
    }
    if (!req.cookies.get('clientKey')) {
      // HttpOnly + SameSite=Lax（doc §2.1）。导出历史依赖此 Cookie（Q-13）。
      res.cookies.set('clientKey', crypto.randomUUID(), { httpOnly: true, sameSite: 'lax', path: '/' });
    }
    return res;
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next|favicon.ico|api/auth).*)'],
};
