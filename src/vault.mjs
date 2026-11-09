// 租户保险箱。只用 WebCrypto，Node 20+ / Cloudflare Workers / Vercel 都能跑。两种模式：
//
// 一、有存储（stored）：一个连接一条记录，记录名和内容都由用户的连接密钥派生 / 加密。
//   连接密钥  cvk_<32 字节随机数的 base64url>      只在注册时展示一次，服务端不保存
//   记录名    HKDF(密钥, 盐=服务端密钥, "canvasm/v1/id")  → 16 字节 hex
//   加密密钥  HKDF(密钥, 盐=服务端密钥, "canvasm/v1/enc") → AES-256-GCM，AAD = 记录名
//   记录内容  "JXC1" | nonce(12) | 密文+tag，明文是补齐到 256 字节整数倍的 JSON {b: 学校地址, t: 令牌, c: 注册日期}
//   没有连接密钥，只拿到存储（硬盘、备份、KV）看不出是谁、哪所学校、令牌是什么。
//
// 二、无存储（stateless）：服务端什么都不存，连接密钥本身就是“密封的令牌”。
//   连接密钥  cvs_<nonce(12) | AES-256-GCM(HKDF(服务端密钥, "…/sealed"), JSON)> 的 base64url
//   没有可删的东西：作废一个连接只能去 Canvas 里删掉令牌，或者更换服务端密钥（全部连接一起作废）。

const MAGIC = new Uint8Array([0x4a, 0x58, 0x43, 0x31]); // "JXC1"
const STORED_KEY = /^cvk_[A-Za-z0-9_-]{43}$/;
const SEALED_KEY = /^cvs_[A-Za-z0-9_-]{60,800}$/;
const PAD = 256;
const utf8 = new TextEncoder();
const text = new TextDecoder();

const toB64u = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
function fromB64u(str) {
  const bin = atob(str.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) out.set(p, offset), (offset += p.length);
  return out;
};
const today = () => new Date().toISOString().slice(0, 10);

/** 服务端密钥：64 位 hex 直接当 32 字节用；其他字符串（至少 32 个字符）取 SHA-256 */
export async function secretBytes(secret) {
  if (typeof secret !== 'string') return null;
  const s = secret.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Uint8Array.from(s.match(/../g), (h) => parseInt(h, 16));
  if (s.length < 32) return null;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(s)));
}

async function hkdf(ikm, salt, info, usage) {
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const params = { name: 'HKDF', hash: 'SHA-256', salt, info: utf8.encode(info) };
  if (usage === 'id') return toHex(new Uint8Array(await crypto.subtle.deriveBits(params, base, 128)));
  return crypto.subtle.deriveKey(params, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export class Vault {
  /**
   * @param {Uint8Array} secret 32 字节服务端密钥
   * @param {{get(id): Promise<Uint8Array|null>, put(id, bytes): Promise<void>, delete(id): Promise<boolean>, touch?(id): void}|null} store
   */
  constructor(secret, store) {
    this.secret = secret;
    this.store = store ?? null;
    this.mode = store ? 'stored' : 'stateless';
    this.sealKey = null;
  }

  // ---------- stored ----------

  async #derive(key) {
    if (!STORED_KEY.test(key)) return null;
    const raw = fromB64u(key.slice(4));
    if (raw.length !== 32) return null;
    return { id: await hkdf(raw, this.secret, 'canvasm/v1/id', 'id'), enc: await hkdf(raw, this.secret, 'canvasm/v1/enc', 'key') };
  }

  async #write(d, record) {
    const json = utf8.encode(JSON.stringify(record));
    const plain = new Uint8Array(Math.ceil((json.length + 1) / PAD) * PAD).fill(0x20);
    plain.set(json);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: utf8.encode(d.id) }, d.enc, plain));
    await this.store.put(d.id, concat(MAGIC, nonce, body));
  }

  async #openStored(key) {
    const d = await this.#derive(key);
    if (!d) return null;
    const buf = await this.store.get(d.id);
    if (!buf || buf.length < 4 + 12 + 16 || !MAGIC.every((b, i) => buf[i] === b)) return null;
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(4, 16), additionalData: utf8.encode(d.id) }, d.enc, buf.subarray(16));
      const rec = JSON.parse(text.decode(plain));
      this.store.touch?.(d.id);
      return { id: d.id, base: rec.b, token: rec.t, created: rec.c };
    } catch {
      return null;
    }
  }

  // ---------- stateless ----------

  async #seal() {
    this.sealKey ??= await hkdf(this.secret, new Uint8Array(0), 'canvasm/v1/sealed', 'key');
    return this.sealKey;
  }

  async #openSealed(key) {
    if (!SEALED_KEY.test(key)) return null;
    try {
      const buf = fromB64u(key.slice(4));
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(0, 12), additionalData: utf8.encode('cvs') }, await this.#seal(), buf.subarray(12));
      const rec = JSON.parse(text.decode(plain));
      const id = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(key)))).slice(0, 32);
      return { id, base: rec.b, token: rec.t, created: rec.c };
    } catch {
      return null;
    }
  }

  // ---------- 对外 ----------

  /** 新建连接，返回连接密钥（唯一一次） */
  async create(base, token) {
    const record = { b: base, t: token, c: today() };
    if (this.mode === 'stateless') {
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: utf8.encode('cvs') }, await this.#seal(), utf8.encode(JSON.stringify(record))));
      return `cvs_${toB64u(concat(nonce, body))}`;
    }
    const key = `cvk_${toB64u(crypto.getRandomValues(new Uint8Array(32)))}`;
    await this.#write(await this.#derive(key), record);
    return key;
  }

  /** 连接密钥 → { id, base, token, created }；密钥不对 / 记录不存在 / 解不开都返回 null */
  async open(key) {
    if (typeof key !== 'string') return null;
    return this.mode === 'stateless' ? this.#openSealed(key) : this.#openStored(key);
  }

  /** 只有 stored 模式能删 */
  async remove(key) {
    if (this.mode !== 'stored' || typeof key !== 'string') return false;
    const d = await this.#derive(key);
    return d ? this.store.delete(d.id) : false;
  }

  /** 只有 stored 模式能换：用新密钥重新加密，删掉旧记录 */
  async rotate(key) {
    if (this.mode !== 'stored') return null;
    const tenant = await this.#openStored(key);
    if (!tenant) return null;
    const next = `cvk_${toB64u(crypto.getRandomValues(new Uint8Array(32)))}`;
    await this.#write(await this.#derive(next), { b: tenant.base, t: tenant.token, c: tenant.created });
    await this.remove(key);
    return next;
  }
}
