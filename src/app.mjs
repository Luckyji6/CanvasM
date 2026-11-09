// 平台无关的核心：createApp(env, store) 返回一个 (Request) => Response | null 的处理函数。
// 只处理 /healthz、/api/*、/mcp；其他路径返回 null，交给各平台自己发静态页面。
// 只用 Web 标准接口（fetch / Request / Response / WebCrypto），Node 20+、Cloudflare Workers、Vercel 通用。
//
// 原则：不记任何访问 / 内容日志；除了连接记录（有存储时）不保存任何东西。

import { Vault, secretBytes } from './vault.mjs';
import { CanvasError, normalizeBase, settings as canvasSettings, verifyToken } from './canvas.mjs';
import { handleMcp } from './mcp.mjs';
import { RateLimiter } from './limits.mjs';

export const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'x-robots-tag': 'noindex, nofollow',
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      'cache-control': 'no-store',
      ...(body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }),
      ...headers,
    },
  });
}

async function readJson(request, limit) {
  if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send application/json');
  }
  if (Number(request.headers.get('content-length') ?? 0) > limit) throw new HttpError(413, 'TOO_LARGE', 'Request body is too large');
  const text = await request.text();
  if (text.length > limit) throw new HttpError(413, 'TOO_LARGE', 'Request body is too large');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
}

// 这些头都由前面的平台 / 反代写入（Cloudflare、Vercel、自己的 nginx），客户端伪造不了
const clientIp = (request) =>
  (request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown').slice(0, 64);

function givenKey(request) {
  const header = request.headers.get('x-api-key');
  if (header && header.trim()) return header.trim();
  return /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
}

async function sameText(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))));
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const SECRET_NAME = 'secret';

/**
 * 服务端密钥从哪来（按顺序）：
 *  1. 环境变量 GATEWAY_SECRET
 *  2. 有存储时：第一次运行自动生成一份存进去，之后一直用它
 *  3. Vercel：用平台自带的 VERCEL_PROJECT_ID 派生（项目 ID 不公开；想更稳妥就自己设 GATEWAY_SECRET）
 * 都没有 → null，接口返回 503。
 */
async function resolveSecret(env, store) {
  const explicit = await secretBytes(env.GATEWAY_SECRET);
  if (explicit) return explicit;
  if (store?.getMeta) {
    let saved = await store.getMeta(SECRET_NAME);
    if (!saved || saved.length !== 32) {
      await store.putMeta(SECRET_NAME, crypto.getRandomValues(new Uint8Array(32)));
      saved = await store.getMeta(SECRET_NAME); // 两个实例同时初始化时，以存进去的那份为准
    }
    if (saved?.length === 32) return saved;
  }
  if (env.VERCEL_PROJECT_ID) return secretBytes(`canvasm/vercel/${env.VERCEL_PROJECT_ID}/${'x'.repeat(32)}`);
  return null;
}

/**
 * @param {Record<string, string|undefined>} env 环境变量（Workers 的 env / process.env）
 * @param {object|null} store 存储适配器；null = 无存储模式
 * @param {{maxConnections?: number}} [options] maxConnections：最多允许几个连接（需要存储支持 count）；不传 = 不限
 */
export function createApp(env, store, options = {}) {
  const maxConnections = options.maxConnections ?? Infinity;
  const accessCode = env.ACCESS_CODE || '';
  const publicUrl = (env.PUBLIC_URL || '').replace(/\/+$/, '');
  const defaultSchool = env.DEFAULT_SCHOOL || '';
  canvasSettings.testBase = env.CANVAS_GATEWAY_TEST_BASE || '';
  const limiter = new RateLimiter();
  let vaultPromise = null;

  const getVault = () =>
    (vaultPromise ??= resolveSecret(env, store).then((secret) => {
      if (!secret) {
        vaultPromise = null;
        throw new HttpError(503, 'NOT_CONFIGURED', 'The gateway has no secret yet: set the GATEWAY_SECRET environment variable (any random string of 32+ characters) and redeploy');
      }
      return new Vault(secret, store);
    }));

  /** 连接密钥 → 租户；失败按 IP 计数（额度放宽是因为 AI 平台的出口 IP 是很多人共用的） */
  async function authenticate(request) {
    const ip = clientIp(request);
    if (limiter.blocked(`authfail:${ip}`, 60)) throw new HttpError(429, 'RATE_LIMITED', 'Too many failed attempts; try again later');
    const tenant = await (await getVault()).open(givenKey(request));
    if (!tenant) {
      limiter.hit(`authfail:${ip}`, 60, 10 * 60_000);
      throw new HttpError(401, 'UNAUTHORIZED', 'Missing or invalid connection key');
    }
    return tenant;
  }

  async function route(request) {
    const url = new URL(request.url);
    // Vercel 上函数都在 /api/ 下，/mcp 和 /healthz 通过 rewrite 进来，两种写法都认
    const path = url.pathname === '/api/mcp' ? '/mcp' : url.pathname === '/api/healthz' ? '/healthz' : url.pathname;
    if (path !== '/mcp' && path !== '/healthz' && !path.startsWith('/api/')) return null;
    const mcpUrl = `${publicUrl || url.origin}/mcp`;
    const ip = clientIp(request);

    if (request.method === 'GET' || request.method === 'HEAD') {
      if (path === '/healthz') return json(200, { ok: true });
      if (path === '/api/config') {
        const mode = await getVault().then((v) => v.mode, () => (store ? 'stored' : 'stateless'));
        return json(200, { accessCodeRequired: accessCode !== '', mcpUrl, mode, defaultSchool });
      }
      if (path === '/mcp') return json(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST' } }, { allow: 'POST' });
      throw new HttpError(404, 'NOT_FOUND', 'Not found');
    }
    if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');

    if (path === '/mcp') {
      const tenant = await authenticate(request);
      if (!limiter.hit(`mcp:${tenant.id}`, 120, 60_000)) throw new HttpError(429, 'RATE_LIMITED', 'Too many requests; slow down');
      const out = await handleMcp(tenant, await readJson(request, 256 * 1024));
      return out === null ? json(202) : json(200, out);
    }

    if (!limiter.hit(`api:${ip}`, 30, 60_000)) throw new HttpError(429, 'RATE_LIMITED', '操作太频繁，请一分钟后再试');
    const vault = await getVault();

    if (path === '/api/register') {
      if (!limiter.hit(`register:${ip}`, 8, 10 * 60_000)) throw new HttpError(429, 'RATE_LIMITED', '尝试次数太多，请十分钟后再试');
      const body = await readJson(request, 8 * 1024);
      if (accessCode && !(typeof body.accessCode === 'string' && (await sameText(body.accessCode.trim(), accessCode)))) {
        throw new HttpError(403, 'ACCESS_CODE_INVALID', '访问码不对');
      }
      const base = normalizeBase(body.school);
      if (!base) throw new HttpError(400, 'SCHOOL_INVALID', '学校地址要写成 学校名.instructure.com');
      const token = typeof body.token === 'string' ? body.token.trim() : '';
      if (token.length < 20 || token.length > 300 || /\s/.test(token)) throw new HttpError(400, 'TOKEN_INVALID', '令牌格式不对，请完整复制 Canvas 生成的那一串');
      const check = await verifyToken({ base, token });
      if (!check.ok) {
        throw check.reason === 'TOKEN_INVALID'
          ? new HttpError(400, 'TOKEN_INVALID', 'Canvas 不接受这个令牌，请确认复制完整、没有过期')
          : new HttpError(400, 'SCHOOL_NOT_FOUND', '在这个地址上没找到 Canvas，请检查学校地址');
      }
      if (Number.isFinite(maxConnections) && store?.count && (await store.count()) >= maxConnections) {
        throw new HttpError(409, 'LIMIT_REACHED', maxConnections === 1 ? '这个部署只允许一个连接，而且已经有人连上了。想换成自己的，先在“管理连接”里用原来的连接密钥删除它。' : '这个部署的连接数已经满了。');
      }
      const key = await vault.create(base, token);
      return json(201, { key, mcpUrl, school: new URL(base).hostname, name: check.name, mode: vault.mode });
    }

    if (path === '/api/status') {
      const tenant = await authenticate(request);
      const check = await verifyToken(tenant).catch(() => ({ ok: null }));
      return json(200, { school: new URL(tenant.base).hostname, created: tenant.created, tokenValid: check.ok, name: check.ok ? check.name : undefined });
    }

    if (path === '/api/rotate' || path === '/api/delete') {
      await authenticate(request);
      if (vault.mode !== 'stored') {
        throw new HttpError(409, 'NOT_AVAILABLE', '这个部署不保存任何连接，所以没有可更换或删除的东西。要作废连接，请到 Canvas 的 Settings 里删掉那个令牌。');
      }
      if (path === '/api/delete') {
        await vault.remove(givenKey(request));
        return json(204);
      }
      const key = await vault.rotate(givenKey(request));
      if (!key) throw new HttpError(401, 'UNAUTHORIZED', 'Missing or invalid connection key');
      return json(200, { key });
    }

    throw new HttpError(404, 'NOT_FOUND', 'Not found');
  }

  return async function handle(request) {
    try {
      return await route(request);
    } catch (err) {
      if (err instanceof HttpError || err instanceof CanvasError) {
        const message = err.code === 'CANVAS_UNREACHABLE' || err.code === 'CANVAS_TIMEOUT' ? '暂时连不上 Canvas，请稍后再试' : err.message;
        return json(err.status, { error: { code: err.code, message } });
      }
      // 未预料的错误：只记错误类型，不记消息和请求（消息里可能带用户数据）
      console.error(`canvasm: unhandled ${err?.name ?? 'error'}`);
      return json(500, { error: { code: 'INTERNAL_ERROR', message: 'Internal error' } });
    }
  };
}

export const notFound = () => json(404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
