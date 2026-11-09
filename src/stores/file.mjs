// 文件存储（自己的服务器用）：<dir>/tenants/<id>.jxc，一个连接一个文件，不用数据库。

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class FileStore {
  constructor(dir) {
    this.root = dir;
    this.dir = path.join(dir, 'tenants');
    this.touched = new Map(); // id → 上次更新 mtime 的日期（只为清理长期不用的连接，粒度一天）
  }

  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    return this;
  }

  #file(id) {
    if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('bad id');
    return path.join(this.dir, `${id}.jxc`);
  }

  // 服务端密钥这类小东西：<dir>/<name>.key
  async getMeta(name) {
    try {
      return new Uint8Array(await readFile(path.join(this.root, `${name}.key`)));
    } catch {
      return null;
    }
  }

  async putMeta(name, bytes) {
    await writeFile(path.join(this.root, `${name}.key`), bytes, { mode: 0o600, flag: 'wx' }).catch(() => undefined);
  }

  async get(id) {
    try {
      return new Uint8Array(await readFile(this.#file(id)));
    } catch {
      return null;
    }
  }

  async put(id, bytes) {
    const file = this.#file(id);
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' });
    await rename(tmp, file);
  }

  async delete(id) {
    this.touched.delete(id);
    try {
      await rm(this.#file(id));
      return true;
    } catch {
      return false;
    }
  }

  touch(id) {
    const day = new Date().toISOString().slice(0, 10);
    if (this.touched.get(id) === day) return;
    this.touched.set(id, day);
    const now = new Date();
    utimes(this.#file(id), now, now).catch(() => undefined);
  }

  async count() {
    return (await readdir(this.dir)).filter((n) => n.endsWith('.jxc')).length;
  }

  /** 删掉超过 days 天没用过的连接，返回删除数量 */
  async prune(days) {
    const cutoff = Date.now() - days * 86_400_000;
    let removed = 0;
    for (const name of await readdir(this.dir)) {
      const file = path.join(this.dir, name);
      const info = await stat(file).catch(() => null);
      if (info && info.mtimeMs < cutoff) {
        await rm(file, { force: true });
        removed++;
      }
    }
    return removed;
  }
}
