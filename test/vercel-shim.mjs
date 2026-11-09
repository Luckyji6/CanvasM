// 测试用：在本机模拟 Vercel 的路由（/api/<name> → api/<name>.mjs，/mcp、/healthz 走 rewrite），
// 用和线上一样的 Web 标准签名调用 api/ 下的函数。不是部署入口。

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const REWRITES = { '/mcp': '/api/mcp', '/healthz': '/api/healthz' };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'" });
    return res.end(await readFile(new URL('../public/index.html', import.meta.url)));
  }
  url.pathname = REWRITES[url.pathname] ?? url.pathname;
  const name = /^\/api\/([a-z]+)$/.exec(url.pathname)?.[1];
  const mod = name && (await import(`../api/${name}.mjs`).catch(() => null));
  const handler = mod?.[req.method];
  if (!handler) return res.writeHead(404).end();
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  headers.set('x-forwarded-for', '203.0.113.9');
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks);
  const response = await handler(new Request(url, { method: req.method, headers, body }));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
}).listen(Number(process.env.PORT), '127.0.0.1', () => process.stderr.write('vercel-shim: listening\n'));
