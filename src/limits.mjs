// 内存里的固定窗口限流。键里只有 IP 或连接的记录名，不落盘。
// 不用定时器（Workers 不允许在全局作用域起定时器）：每分钟顺手清一次过期窗口。
// 在无服务器平台上每个实例各算各的，只能算尽力而为。

export class RateLimiter {
  constructor() {
    this.windows = new Map(); // key → { count, resetAt }
    this.sweptAt = 0;
  }

  /** 计一次；窗口内没超过 max 返回 true */
  hit(key, max, windowMs) {
    const now = Date.now();
    if (now - this.sweptAt > 60_000) this.#sweep(now);
    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, w);
    }
    w.count++;
    return w.count <= max;
  }

  /** 不计数，只看当前窗口是否已经达到 max */
  blocked(key, max) {
    const w = this.windows.get(key);
    return !!w && w.resetAt > Date.now() && w.count >= max;
  }

  #sweep(now) {
    this.sweptAt = now;
    for (const [key, w] of this.windows) if (w.resetAt <= now) this.windows.delete(key);
  }
}
