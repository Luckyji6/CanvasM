// Node 入口（自己的服务器用）：node server.mjs。零依赖，Node 20+。
// 连接记录存在 DATA_DIR/tenants/ 下的加密文件里；STORAGE=none 时改用无存储模式。
// 进程只在启动和崩溃时往 stderr 打一行，不含任何请求信息。

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SECURITY_HEADERS, createApp, notFound } from './src/app.mjs';
import { FileStore } from './src/stores/file.mjs';

const env = process.env;
const HOST = env.HOST || '127.0.0.1';
const PORT = Number(env.PORT || 3943);
const DATA_DIR = env.DATA_DIR || fileURLToPath(new URL('./data/', import.meta.url));

const store = env.STORAGE === 'none' ? null : await new FileStore(DATA_DIR).init();
const app = createApp(env, store);

// ---------- 静态文件（启动时读进内存，只发这几个） ----------

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/security': ['security.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/security.js': ['security.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const assets = new Map();
for (const [route, [file, type]] of Object.entries(STATIC)) {
  assets.set(route, { type, body: await readFile(new URL(`./public/${file}`, import.meta.url)) });
}
// 样式和脚本的地址带上内容指纹（/style.css?v=…）：页面一更新，浏览器和 CDN 就不会再用旧缓存配新页面
for (const asset of assets.values()) {
  if (!asset.type.startsWith('text/html')) continue;
  let html = asset.body.toString('utf8');
  for (const route of ['/style.css', '/app.js', '/security.js']) {
    const version = createHash('sha256').update(assets.get(route).body).digest('hex').slice(0, 10);
    html = html.replaceAll(`"${route}"`, `"${route}?v=${version}"`);
  }
  asset.body = Buffer.from(html);
}

// ---------- node:http ↔ Web Request / Response ----------

const MAX_BODY = 300 * 1024;

async function toRequest(req) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value);
  }
  // 没有反代写入的客户端地址时（本机直连），用 socket 地址
  if (!headers.has('cf-connecting-ip') && !headers.has('x-real-ip')) headers.set('x-real-ip', req.socket.remoteAddress ?? 'unknown');
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) return null;
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  }
  return new Request(`http://${req.headers.host || 'localhost'}${req.url}`, { method: req.method, headers, body });
}

async function handle(req, res) {
  const path = new URL(req.url, 'http://x').pathname;
  if (req.method === 'GET' || req.method === 'HEAD') {
    const asset = assets.get(path);
    if (asset) {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': asset.type,
        'cache-control': asset.type.startsWith('text/html') ? 'no-cache' : 'public, max-age=300',
      });
      return res.end(req.method === 'HEAD' ? undefined : asset.body);
    }
  }
  const request = await toRequest(req);
  const response = request
    ? ((await app(request)) ?? notFound())
    : new Response(JSON.stringify({ error: { code: 'TOO_LARGE', message: 'Request body is too large' } }), { status: 413, headers: { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' } });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    process.stderr.write(`canvasm: unhandled ${err?.name ?? 'error'}\n`);
    if (res.headersSent) return res.destroy();
    res.writeHead(500, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' });
    res.end('{"error":{"code":"INTERNAL_ERROR","message":"Internal error"}}');
  });
});
server.requestTimeout = 60_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 60;
server.listen(PORT, HOST, () => process.stderr.write(`canvasm: listening on ${HOST}:${PORT}\n`));

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
