'use strict';
// 按这个部署的模式（有存储 / 无存储）显示对应的说明
fetch('/api/config', { cache: 'no-store' })
  .then((r) => r.json())
  .then((config) => {
    if (config.mode) document.documentElement.dataset.mode = config.mode;
  })
  .catch(() => undefined);
