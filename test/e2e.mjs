// 端到端测试：起一个假的 Canvas，再把网关按不同的部署方式各跑一遍，走完 注册 → MCP → 管理。
// 用法：node test/e2e.mjs [node] [node-stateless] [vercel] [worker]
//   不带参数 = node、node-stateless、vercel 三种；worker 需要能联网装 wrangler，要显式写出来。

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const TOKEN = `1234~${'A'.repeat(60)}`;
let failed = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${extra}`}`);
};

// ---------- 假 Canvas ----------
const seen = [];
const canvas = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  seen.push(`${req.method} ${url.pathname}${url.search}`);
  const json = (status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(body));
  };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { errors: [{ message: 'Invalid access token.' }] });
  const origin = `http://${req.headers.host}`;
  if (url.pathname === '/api/v1/users/self') return json(200, { id: 7, name: 'Test Student', short_name: 'Test', email: 'secret@example.com', sis_user_id: 'S123', avatar_url: 'https://x/y.png' });
  if (url.pathname === '/api/v1/courses') {
    const page = url.searchParams.get('page') ?? '1';
    const link = page === '1' ? { link: `<${origin}/api/v1/courses?page=2>; rel="next"` } : {};
    return json(200, [{ id: Number(page), name: `Course ${page}`, calendar: { ics: 'https://x/feed.ics' }, html_url: `https://x/f?verifier=abc123&x=1` }], link);
  }
  if (url.pathname === '/api/v1/echo') return json(200, { query: url.search });
  if (url.pathname === '/api/v1/redirect-out') return res.writeHead(302, { location: 'https://example.com/file' }).end();
  if (url.pathname === '/api/graphql') {
    let body = '';
    req.on('data', (c) => (body += c));
    return req.on('end', () => json(200, { data: { received: JSON.parse(body).query } }));
  }
  json(404, { errors: [{ message: 'not found' }] });
});
await new Promise((r) => canvas.listen(0, '127.0.0.1', r));
const CANVAS = `http://127.0.0.1:${canvas.address().port}`;

// ---------- 各种部署方式 ----------
const root = fileURLToPath(new URL('..', import.meta.url));
const common = { PATH: process.env.PATH, HOME: process.env.HOME, CANVAS_GATEWAY_TEST_BASE: CANVAS, ACCESS_CODE: 'letmein', DEFAULT_SCHOOL: 'demo.instructure.com' };
const TARGETS = {
  // 自己的服务器：文件存储，不设任何密钥（自动生成）
  node: (port, dataDir) => ({ stored: true, dataDir, cmd: [process.execPath, 'server.mjs'], env: { ...common, PORT: String(port), DATA_DIR: dataDir } }),
  // 自己的服务器，无存储
  'node-stateless': (port) => ({ stored: false, cmd: [process.execPath, 'server.mjs'], env: { ...common, PORT: String(port), STORAGE: 'none', GATEWAY_SECRET: randomBytes(32).toString('hex') } }),
  // Vercel：api/*.mjs，不设任何密钥（用平台自带的项目 ID）
  vercel: (port) => ({ stored: false, cmd: [process.execPath, 'test/vercel-shim.mjs'], env: { ...common, PORT: String(port), VERCEL_PROJECT_ID: `prj_${randomBytes(12).toString('hex')}` } }),
  // Cloudflare Workers：wrangler dev（本地模拟 KV 和静态资源），不设任何密钥（自动生成后存进 KV）
  worker: (port, dataDir) => ({
    stored: true,
    cmd: ['npx', '--yes', 'wrangler@4', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', dataDir, '--show-interactive-dev-session=false',
      '--var', `CANVAS_GATEWAY_TEST_BASE:${CANVAS}`, '--var', 'ACCESS_CODE:letmein', '--var', 'DEFAULT_SCHOOL:demo.instructure.com'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
    slow: true,
    single: true,
  }),
};

async function run(target) {
  console.log(`\n=== ${target} ===`);
  const tmp = await mkdtemp(path.join(tmpdir(), 'canvasm-e2e-'));
  const PORT = 20000 + Math.floor(Math.random() * 20000);
  const spec = TARGETS[target](PORT, tmp);
  const { stored, dataDir } = spec;
  const gateway = spawn(spec.cmd[0], spec.cmd.slice(1), { cwd: root, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  gateway.stdout.on('data', (c) => (output += c));
  gateway.stderr.on('data', (c) => (output += c));
  const GW = `http://127.0.0.1:${PORT}`;
  let up = false;
  for (let i = 0; i < (spec.slow ? 900 : 50) && !up; i++) {
    up = await fetch(`${GW}/healthz`).then((r) => r.ok, () => false);
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) {
    check(`${target} 启动`, false, output.slice(-600));
    gateway.kill();
    return;
  }

  const post = async (p, body, key) => {
    const res = await fetch(GW + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) }, body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  let rpcId = 0;
  const rpc = (key, method, params) => post('/mcp', { jsonrpc: '2.0', id: ++rpcId, method, params }, key);
  const tool = async (key, name, args) => {
    const r = await rpc(key, 'tools/call', { name, arguments: args });
    const result = r.body.result;
    return { isError: !!result.isError, text: result.content[0].text };
  };

  try {
    // 页面和安全头
    const page = await fetch(`${GW}/`);
    check('首页 200 + CSP', page.status === 200 && /default-src 'none'/.test(page.headers.get('content-security-policy') ?? ''));
    check('未知路径 404', (await fetch(`${GW}/.env`)).status === 404);
    check('不发源码', (await fetch(`${GW}/server.mjs`)).status === 404);
    const config = await (await fetch(`${GW}/api/config`)).json();
    check(`模式是 ${stored ? 'stored' : 'stateless'}，MCP 地址取自访问域名`, config.mode === (stored ? 'stored' : 'stateless') && config.mcpUrl === `${GW}/mcp` && config.defaultSchool === 'demo.instructure.com', JSON.stringify(config));

    // 注册
    check('访问码不对 → 403', (await post('/api/register', { school: CANVAS, token: TOKEN, accessCode: 'nope' })).status === 403);
    check('学校地址不允许 → 400', (await post('/api/register', { school: 'http://127.0.0.1:22', token: TOKEN, accessCode: 'letmein' })).body.error.code === 'SCHOOL_INVALID');
    check('学校地址不允许（非 instructure）', (await post('/api/register', { school: 'evil.com', token: TOKEN, accessCode: 'letmein' })).body.error.code === 'SCHOOL_INVALID');
    check('学校地址不允许（伪装后缀）', (await post('/api/register', { school: 'x.instructure.com.evil.com', token: TOKEN, accessCode: 'letmein' })).body.error.code === 'SCHOOL_INVALID');
    check('令牌无效 → 400', (await post('/api/register', { school: CANVAS, token: `9999~${'B'.repeat(60)}`, accessCode: 'letmein' })).body.error.code === 'TOKEN_INVALID');
    const reg = await post('/api/register', { school: CANVAS, token: TOKEN, accessCode: 'letmein' });
    check('注册成功 201', reg.status === 201 && (stored ? /^cvk_[A-Za-z0-9_-]{43}$/ : /^cvs_[A-Za-z0-9_-]{60,}$/).test(reg.body.key) && reg.body.name === 'Test', JSON.stringify(reg.body));
    const key = reg.body.key;
    if (spec.single) check('只允许一个连接：第二个 → 409', (await post('/api/register', { school: CANVAS, token: TOKEN, accessCode: 'letmein' })).body.error.code === 'LIMIT_REACHED');

    if (dataDir) {
      // 落盘的文件解不开
      const files = await readdir(path.join(dataDir, 'tenants'));
      const raw = await readFile(path.join(dataDir, 'tenants', files[0]));
      const asText = raw.toString('latin1');
      check('只有一条记录，名字与密钥无关', files.length === 1 && /^[0-9a-f]{32}\.jxc$/.test(files[0]) && !files[0].includes(key.slice(4, 12)));
      check('文件里没有令牌 / 学校地址 / 密钥明文', !asText.includes(TOKEN) && !asText.includes('127.0.0.1') && !asText.includes(key) && !asText.includes('AAAA'));
      check('文件长度固定（补齐）', raw.length === 4 + 12 + 256 + 16, String(raw.length));
      check('自动生成的服务端密钥单独存放', (await readFile(path.join(dataDir, 'secret.key'))).length === 32);
    }
    if (!stored) {
      const raw = Buffer.from(key.slice(4), 'base64url').toString('latin1');
      check('连接密钥里看不到令牌 / 学校明文', !raw.includes(TOKEN) && !raw.includes('127.0.0.1') && !raw.includes('AAAA'));
      const forged = key.slice(0, -6) + (key.endsWith('AAAAAA') ? 'BBBBBB' : 'AAAAAA');
      check('改过的连接密钥 → 401', (await rpc(forged, 'tools/list')).status === 401);
    }

    // MCP
    check('没密钥 → 401', (await rpc('', 'tools/list')).status === 401);
    check('错密钥 → 401', (await rpc(`cvk_${'x'.repeat(43)}`, 'tools/list')).status === 401 && (await rpc(`cvs_${'x'.repeat(200)}`, 'tools/list')).status === 401);
    const init = await rpc(key, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    check('initialize', init.body.result.protocolVersion === '2025-06-18' && init.body.result.capabilities.tools);
    const note = await fetch(`${GW}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    check('通知 → 202', note.status === 202);
    const list = await rpc(key, 'tools/list');
    check('只有两个只读工具', list.body.result.tools.map((t) => t.name).join() === 'canvas_get,canvas_graphql');

    const self = await tool(key, 'canvas_get', { path: '/api/v1/users/self' });
    check('canvas_get 脱敏', !self.isError && self.text.includes('Test Student') && !self.text.includes('secret@example.com') && !self.text.includes('S123'), self.text);
    const courses = await tool(key, 'canvas_get', { path: '/api/v1/courses', max_pages: 5 });
    check('翻页合并 + ics / verifier 抹掉', JSON.parse(courses.text).data.length === 2 && !courses.text.includes('feed.ics') && !courses.text.includes('abc123'), courses.text);
    const echo = await tool(key, 'canvas_get', { path: '/api/v1/echo', query: { include: ['a', 'b'], per_page: 50 } });
    check('数组参数写成 key[]=', JSON.parse(echo.text).data.query === '?include[]=a&include[]=b&per_page=50', echo.text);

    for (const [name, p] of [
      ['同学名单', '/api/v1/courses/1/users'],
      ['同学名单 .json 后缀', '/api/v1/courses/1/users.json'],
      ['站内信', '/api/v1/conversations'],
      ['令牌列表', '/api/v1/users/self/tokens'],
      ['编码绕过', '/api/v1/courses/1/%75sers'],
      ['双斜杠绕过', '/api/v1/courses//1/users'],
      ['非 API 路径', '/courses/1'],
      ['跳到别的主机', '//example.com/api/v1/x'],
      ['反斜杠', '/\\example.com/api/v1/x'],
    ]) {
      const before = seen.length;
      const r = await tool(key, 'canvas_get', { path: p });
      check(`拦截：${name}`, r.isError && /BLOCKED_FOR_PRIVACY|PATH_NOT_ALLOWED/.test(r.text) && seen.length === before, r.text);
    }
    const out = await tool(key, 'canvas_get', { path: '/api/v1/redirect-out' });
    check('跳外站不跟随', !out.isError && JSON.parse(out.text).status === 302, out.text);

    const gq = await tool(key, 'canvas_graphql', { query: '{ allCourses { name } }' });
    check('GraphQL query', !gq.isError && gq.text.includes('allCourses'), gq.text);
    check('GraphQL mutation 拒绝', (await tool(key, 'canvas_graphql', { query: 'mutation { x }' })).text.startsWith('READ_ONLY'));
    check('GraphQL 屏蔽字段拒绝', (await tool(key, 'canvas_graphql', { query: '{ course(id:1){ usersConnection { nodes { name } } } }' })).text.startsWith('BLOCKED_FOR_PRIVACY'));
    check('未知工具', (await tool(key, 'canvas_write', {})).isError);

    // 管理
    const status = await post('/api/status', {}, key);
    check('状态', status.body.tokenValid === true && status.body.school === '127.0.0.1', JSON.stringify(status.body));
    if (stored) {
      const rotated = await post('/api/rotate', {}, key);
      const key2 = rotated.body.key;
      check('更换密钥', rotated.status === 200 && key2 !== key && (!dataDir || (await readdir(path.join(dataDir, 'tenants'))).length === 1));
      check('旧密钥失效', (await rpc(key, 'tools/list')).status === 401);
      check('新密钥可用', (await rpc(key2, 'tools/list')).status === 200);
      check('删除 204', (await post('/api/delete', {}, key2)).status === 204);
      check('删除后记录清空', !dataDir || (await readdir(path.join(dataDir, 'tenants'))).length === 0);
      check('删除后密钥失效', (await rpc(key2, 'tools/list')).status === 401);
    } else {
      check('无存储：更换 → 409', (await post('/api/rotate', {}, key)).body.error.code === 'NOT_AVAILABLE');
      check('无存储：删除 → 409', (await post('/api/delete', {}, key)).body.error.code === 'NOT_AVAILABLE');
      check('无存储：密钥仍可用', (await rpc(key, 'tools/list')).status === 200);
    }

    // 进程输出里不能有请求痕迹
    if (target !== 'worker') check('进程输出只有启动那一行', output.trim().split('\n').length === 1 && !/cv[ks]_/.test(output) && !output.includes('/api/'), JSON.stringify(output));
  } finally {
    gateway.kill();
    await new Promise((r) => setTimeout(r, 200));
    await rm(tmp, { recursive: true, force: true });
  }
}

const wanted = process.argv.slice(2);
for (const target of wanted.length ? wanted : ['node', 'node-stateless', 'vercel']) {
  if (!TARGETS[target]) throw new Error(`unknown target: ${target}`);
  await run(target);
}
canvas.close();
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
