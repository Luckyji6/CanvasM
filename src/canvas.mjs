// 只读地请求某个租户的 Canvas：校验学校地址和路径 → 隐私屏蔽 → 带令牌请求 → 响应脱敏。

import { blockedGraphqlField, blockedReason, redactJson, scrubSecrets, stripGraphqlComments } from './privacy.mjs';

const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.instructure\.com$/;
const TIMEOUT_MS = 30_000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 5;
// 仅测试用：允许把学校地址指到本机的假 Canvas（由入口从环境变量 CANVAS_GATEWAY_TEST_BASE 传进来）。生产环境不设。
export const settings = { testBase: '' };

export class CanvasError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** 用户填的学校地址（域名或完整网址）→ 规范化的 origin；只接受 *.instructure.com，防止被当成打内网的跳板 */
export function normalizeBase(input) {
  if (typeof input !== 'string') return null;
  let text = input.trim().toLowerCase();
  if (!text || text.length > 200) return null;
  if (settings.testBase && text === settings.testBase) return settings.testBase;
  if (!/^https?:\/\//.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.username || url.password || url.port) return null;
  return HOST_RE.test(url.hostname) ? `https://${url.hostname}` : null;
}

const baseAllowed = (base) => (settings.testBase && base === settings.testBase) || normalizeBase(base) === base;

async function readLimited(res) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new CanvasError(502, 'CANVAS_TOO_LARGE', 'Canvas response is too large; narrow the query');
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

/**
 * @param {{base: string, token: string}} tenant
 * @param {{method: 'GET'|'POST', pathAndQuery: string, json?: unknown}} req
 * @returns {Promise<{status: number, json: boolean, body: unknown, next: string|null, contentType: string|null}>}
 */
export async function canvasFetch(tenant, req) {
  if (!baseAllowed(tenant.base)) throw new CanvasError(500, 'BAD_TENANT', 'Stored school address is not allowed');
  const base = new URL(tenant.base);
  if (req.pathAndQuery.includes('\\')) throw new CanvasError(400, 'PATH_NOT_ALLOWED', 'Backslashes are not allowed in the path');
  let url = new URL(req.pathAndQuery, base);
  const p = url.pathname;
  // 路径里不允许编码字符和重复斜杠：屏蔽规则按字面匹配，不给 %75sers、//users 这类写法留口子
  if (url.origin !== base.origin || !p.startsWith('/api/') || p.includes('%') || p.includes('//')) {
    throw new CanvasError(400, 'PATH_NOT_ALLOWED', 'Only Canvas API paths (/api/...) on your own school can be requested');
  }
  const blocked = blockedReason(p);
  if (blocked) throw new CanvasError(403, 'BLOCKED_FOR_PRIVACY', `This endpoint is blocked for privacy (${blocked})`);

  for (let hop = 0; ; hop++) {
    let res;
    try {
      res = await fetch(url, {
        method: req.method,
        headers: {
          authorization: `Bearer ${tenant.token}`,
          accept: 'application/json',
          ...(req.json !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: req.json !== undefined && hop === 0 ? JSON.stringify(req.json) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const timeout = err?.name === 'TimeoutError';
      throw new CanvasError(timeout ? 504 : 502, timeout ? 'CANVAS_TIMEOUT' : 'CANVAS_UNREACHABLE', timeout ? 'Canvas did not respond in time' : 'Could not reach Canvas');
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      const next = new URL(location, url);
      // 只在本校 Canvas 内跟随跳转；跳到外站（文件存储等）不跟，令牌绝不带出去
      if (req.method !== 'GET' || hop >= MAX_REDIRECTS || next.origin !== base.origin || blockedReason(next.pathname)) {
        return { status: res.status, json: false, body: null, next: null, contentType: null };
      }
      url = next;
      continue;
    }
    const contentType = res.headers.get('content-type');
    if (!/\bjson\b/i.test(contentType ?? '')) {
      await res.body?.cancel();
      return { status: res.status, json: false, body: null, next: null, contentType };
    }
    const text = (await readLimited(res)).replace(/^while\(1\);/, '');
    let body;
    try {
      body = redactJson(JSON.parse(text));
    } catch {
      body = scrubSecrets(text);
    }
    return { status: res.status, json: true, body, next: nextPage(res, base), contentType };
  }
}

function nextPage(res, base) {
  const match = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '');
  if (!match) return null;
  const next = new URL(match[1], base);
  return next.origin === base.origin ? next.pathname + next.search : null;
}

/** GraphQL：只允许 query；mutation / subscription、查被屏蔽字段的一律拒绝 */
export function checkGraphql(query) {
  const field = blockedGraphqlField(query);
  if (field) throw new CanvasError(403, 'BLOCKED_FOR_PRIVACY', `GraphQL field "${field}" is blocked for privacy`);
  if (/\b(mutation|subscription)\b/.test(stripGraphqlComments(query))) {
    throw new CanvasError(403, 'READ_ONLY', 'This gateway is read-only; mutations are not available');
  }
}

/** 注册 / 状态检查时验证令牌：返回 { ok, name } 或抛 CanvasError */
export async function verifyToken(tenant) {
  const res = await canvasFetch(tenant, { method: 'GET', pathAndQuery: '/api/v1/users/self' });
  if (res.status === 200 && res.json && res.body && typeof res.body === 'object') {
    const name = res.body.short_name || res.body.name;
    return { ok: true, name: typeof name === 'string' ? name.slice(0, 80) : '' };
  }
  // 不存在的学校域名返回 404；令牌不对通常是 401，格式离谱的令牌 Canvas 会直接回 500 页面，都算令牌无效
  return { ok: false, reason: res.status === 404 ? 'SCHOOL_NOT_FOUND' : 'TOKEN_INVALID' };
}
