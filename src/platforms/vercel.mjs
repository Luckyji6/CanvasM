// Vercel 入口（api/*.mjs 都转到这里）。Vercel 上没有自带的存储，所以是无存储模式：
// 连接密钥本身就是加密后的令牌，服务端什么都不保存。

import { createApp, notFound } from '../app.mjs';

const app = createApp(process.env, null);
const handler = async (request) => (await app(request)) ?? notFound();

export const GET = handler;
export const POST = handler;
