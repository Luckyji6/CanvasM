// Cloudflare Workers 入口。静态页面由 Workers Static Assets 直接发（见 wrangler.jsonc），这里只处理 /api、/mcp、/healthz。
// 绑定了 KV（TENANTS）就用它保存加密后的连接记录；没绑定就是无存储模式。

import { createApp, notFound } from '../app.mjs';
import { KVStore } from '../stores/kv.mjs';

// 留的小彩蛋：改成 1 就可以多连接啦 Ciallo～(∠・ω< )⌒★!
// （默认 0 = 这个 Worker 只给一个人用：已经有一个连接时，不再接受新的连接。）
const MULTI_CONNECTION = 0;

let app;

export default {
  async fetch(request, env) {
    app ??= createApp(env, env.TENANTS ? new KVStore(env.TENANTS) : null, { maxConnections: MULTI_CONNECTION ? Infinity : 1 });
    return (await app(request)) ?? notFound();
  },
};
