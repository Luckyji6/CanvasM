// Cloudflare Workers KV 存储：键是记录名（乱码），值是加密后的字节。
// KV 是最终一致的：删除 / 更换密钥后，旧密钥在个别节点上最多还能用一分钟左右。

export class KVStore {
  /** @param {KVNamespace} kv */
  constructor(kv) {
    this.kv = kv;
  }

  async getMeta(name) {
    const value = await this.kv.get(`_meta:${name}`, 'arrayBuffer');
    return value ? new Uint8Array(value) : null;
  }

  async putMeta(name, bytes) {
    await this.kv.put(`_meta:${name}`, bytes);
  }

  /** 现有多少条连接记录（只数到 10，够用来判断“有没有”） */
  async count() {
    const { keys } = await this.kv.list({ limit: 10 });
    return keys.filter((k) => !k.name.startsWith('_meta:')).length;
  }

  async get(id) {
    const value = await this.kv.get(id, 'arrayBuffer');
    return value ? new Uint8Array(value) : null;
  }

  async put(id, bytes) {
    await this.kv.put(id, bytes);
  }

  async delete(id) {
    await this.kv.delete(id);
    return true;
  }
}
