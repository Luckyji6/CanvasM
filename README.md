# CanvasM

让 Claude（或任何支持 MCP 的 AI）**只读**地访问你的 Canvas：作业、成绩、公告、待办。

打开部署好的网页，填学校地址和 Canvas 访问令牌，拿到一把连接密钥，填进 AI 的 MCP 连接器就能用。全程自助，没有账号系统。

- **只读**：只有 `canvas_get` 和 `canvas_graphql` 两个工具，不能提交、修改、删除任何东西。
- **隐私过滤**：站内信、同学名单、邮箱电话、登录记录、家长账号、个人文件不转发；邮箱、学号、头像等字段在返回前抹掉。
- **不用数据库，不写日志**：令牌要么加密后才保存（钥匙只在用户手里），要么干脆不保存。
- **零依赖**：只用 Web 标准接口，同一份代码跑在 Cloudflare Workers、Vercel 和自己的服务器上。

## 一键部署

不需要配置任何环境变量。

| | Cloudflare Workers | Vercel |
|---|---|---|
| 部署 | [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Luckyji6/CanvasM) | [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FLuckyji6%2FCanvasM) |
| 令牌保存在哪 | 加密后存进 KV（部署时自动创建） | 不保存：加密后装在连接密钥里，由用户自己拿着 |
| 更换 / 删除连接 | 可以 | 不可以（去 Canvas 里删令牌即可作废） |
| 连接数 | 一个（个人使用） | 不限 |

部署完打开分配给你的网址，照着页面上的三步做就行。页面里有一份白话的安全说明（`/security`）和完整的风险提示。

## 可选的环境变量

都不是必填。

| 变量 | 作用 |
|---|---|
| `ACCESS_CODE` | 设了之后，创建连接要填这个访问码。不想让陌生人用你的部署时设上。 |
| `DEFAULT_SCHOOL` | 预填的学校地址，例如 `myschool.instructure.com`。 |
| `PUBLIC_URL` | 页面上显示的对外地址。默认取访问时的域名。 |
| `GATEWAY_SECRET` | 服务端密钥，任意 32 个字符以上的随机串。默认不用设：Workers 和自己的服务器会在第一次运行时自动生成并保存；Vercel 用平台自带的项目 ID 派生。**更换它会让所有已发出的连接密钥作废。** |

Vercel 的零配置依赖项目设置里的 “Automatically expose System Environment Variables”（默认开启）。关掉了的话，自己设一个 `GATEWAY_SECRET`。

## 它怎么保护数据

两种模式，页面会按当前部署自动显示对应的说明。

**有存储（Workers、自己的服务器）**：每个连接保存为一条 288 字节的加密记录。

```
连接密钥  cvk_<32 字节随机数>          只显示一次，服务端不保存，也不保存它的哈希
记录名    HKDF(连接密钥, 服务端密钥)    一串乱码
内容      AES-256-GCM(HKDF(连接密钥, 服务端密钥), {学校地址, 令牌, 日期})，补齐到固定长度
```

没有连接密钥，拿到全部存储也看不出是谁、哪所学校、令牌是什么。运营者只能数出有几条记录。

**无存储（Vercel）**：服务端什么都不保存，连接密钥本身就是加密后的令牌。

```
连接密钥  cvs_<AES-256-GCM(HKDF(服务端密钥), {学校地址, 令牌, 日期})>
```

两种模式都不记录访问日志和内容日志。学校地址只接受 `*.instructure.com`，令牌只发往该学校的 Canvas。

## 这套办法挡不住什么

部署之前、把网址发给别人之前，请先读完。

- **运营者技术上能看到经过的数据。** Canvas 内容要转交给 AI，必然以明文在服务端内存里经过。程序写成了不保存、不记录，但部署的人可以改程序，使用者无法验证。
- **托管平台和 AI 厂商也会经手明文。** Cloudflare、Vercel 运行着这份程序；内容最终交给使用者选择的 AI。
- **Canvas 手动生成的令牌没有权限范围。** 它等于账号的全部权限。本项目只用它来读，但令牌泄露的后果与此无关。请给令牌设过期时间。
- **这不符合 Canvas 的接口政策。** Canvas 要求多用户应用通过学校签发的开发者密钥走 OAuth，[明确禁止](https://canvas.instructure.com/doc/api/file.oauth.html#manual-token-generation)让其他用户手动生成令牌填进第三方应用。学校可以撤销令牌或关闭这个功能。给自己用和给别人用，风险不一样，后果自负。
- **成绩和作业是教育记录。** 未成年人请让家长知情。

## 自己的服务器

需要 Node 20 以上，没有任何依赖要装。

```bash
git clone https://github.com/Luckyji6/CanvasM.git
cd CanvasM
node server.mjs          # 默认监听 127.0.0.1:3943，数据在 ./data
```

- 连接记录在 `data/tenants/`，自动生成的服务端密钥在 `data/secret.key`。备份时两样分开放；丢了密钥，所有连接作废。
- 前面放一层带 HTTPS 的反代，并关掉这个站点的访问日志。示例见 [deploy/nginx.example.conf](deploy/nginx.example.conf) 和 [deploy/canvasm.service](deploy/canvasm.service)。
- `STORAGE=none` 改用无存储模式（这时必须设 `GATEWAY_SECRET`）；`DATA_DIR`、`HOST`、`PORT` 可改位置和端口。
- `node cli.mjs count` 看现有多少个连接，`node cli.mjs prune 180` 删掉 180 天没用过的。

## 在 AI 里添加

网页上创建连接后会给出具体填法。简单说：

- **claude.ai**：设置 → Connectors → Add custom connector，URL 填 `https://你的域名/mcp`，请求头加 `X-API-Key: <连接密钥>`。
- **Claude Code**：`claude mcp add --transport http canvas https://你的域名/mcp --header "X-API-Key: <连接密钥>"`
- **其他 MCP 客户端**：Streamable HTTP，地址同上，`X-API-Key` 或 `Authorization: Bearer` 都认。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` `/security` | 自助页面、安全说明 |
| GET | `/healthz` | `{ok:true}` |
| GET | `/api/config` | 部署模式、是否需要访问码、MCP 地址 |
| POST | `/api/register` | `{school, token, accessCode?}` → 向 Canvas 验证令牌 → `{key, mcpUrl, school, name}` |
| POST | `/api/status` | 头 `X-API-Key` → `{school, created, tokenValid}` |
| POST | `/api/rotate` | 头 `X-API-Key` → `{key}`（仅有存储模式） |
| POST | `/api/delete` | 头 `X-API-Key` → 204（仅有存储模式） |
| POST | `/mcp` | 远程 MCP，无状态，只回 JSON |

限流在内存里做（每个连接 120 次 / 分钟，注册每 IP 8 次 / 10 分钟）。无服务器平台上每个实例各算各的，只能算尽力而为。

## 开发

```bash
node test/e2e.mjs            # 起一个假的 Canvas，按 Node / 无存储 / Vercel 三种方式各跑一遍
node test/e2e.mjs worker     # 用 wrangler dev 跑 Workers 版（会联网下载 wrangler）
```

```
src/app.mjs          平台无关的核心：(Request) => Response
src/vault.mjs        连接密钥、加密、两种模式
src/canvas.mjs       请求 Canvas：地址和路径校验、跳转处理
src/privacy.mjs      屏蔽的接口和脱敏的字段
src/mcp.mjs          MCP（手写 JSON-RPC）
src/stores/          文件存储、KV 存储
src/platforms/       Workers、Vercel 入口
server.mjs           Node 入口
public/              页面
```

## 许可

[MIT](LICENSE)
