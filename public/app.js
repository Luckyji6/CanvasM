'use strict';
// 连接密钥和令牌只存在于页面内存里：不写 localStorage / cookie，不进 URL。

const $ = (id) => document.getElementById(id);

// ---------- 示意用的“硬盘上的密文”：本地随机字节，只是让人看到落盘的东西长什么样 ----------
{
  const bytes = crypto.getRandomValues(new Uint8Array(160));
  $('noise').textContent = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

// ---------- 视图切换 ----------
const seg = $('seg');
const views = { connect: $('view-connect'), manage: $('view-manage') };

function showView(name, focusTab) {
  seg.dataset.active = name;
  for (const [key, el] of Object.entries(views)) {
    const active = key === name;
    el.hidden = !active;
    const tab = $(`tab-${key}`);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active) {
      el.classList.remove('entering');
      void el.offsetWidth;
      el.classList.add('entering');
      if (focusTab) tab.focus();
    }
  }
}
seg.addEventListener('click', (e) => {
  const item = e.target.closest('.seg-item');
  if (item) showView(item.dataset.view);
});
seg.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    showView(seg.dataset.active === 'connect' ? 'manage' : 'connect', true);
  }
});

// ---------- 请求 ----------
async function api(path, { body, key } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
      body: JSON.stringify(body ?? {}),
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new Error('网络不通，请检查网络后再试');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const code = data?.error?.code;
    if (code === 'UNAUTHORIZED') throw new Error('连接密钥不对，或者这个连接已经删除');
    if (code === 'RATE_LIMITED') throw new Error('操作太频繁，请稍后再试');
    throw new Error(data?.error?.message || '出错了，请稍后再试');
  }
  return data;
}

function setError(el, message) {
  el.textContent = message || '';
  el.hidden = !message;
}

async function busy(button, label, task) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

// ---------- 复制 ----------
document.addEventListener('click', async (e) => {
  const button = e.target.closest('[data-copy]');
  if (!button) return;
  const text = $(button.dataset.copy).textContent;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const range = document.createRange();
    range.selectNodeContents($(button.dataset.copy));
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  button.textContent = '已复制';
  clearTimeout(button._timer);
  button._timer = setTimeout(() => (button.textContent = original), 1600);
});

// ---------- 新建连接 ----------
let mcpUrl = `${location.origin}/mcp`;
fetch('/api/config', { cache: 'no-store' })
  .then((r) => r.json())
  .then((config) => {
    $('field-code').hidden = !config.accessCodeRequired;
    if (config.mcpUrl) mcpUrl = config.mcpUrl;
    if (config.mode) document.documentElement.dataset.mode = config.mode;
    if (config.defaultSchool && !$('school').value) {
      $('school').value = config.defaultSchool;
      $('school-hint').textContent = `已预填 ${config.defaultSchool}。别的学校请改成你登录 Canvas 时浏览器地址栏里的域名。`;
    }
  })
  .catch(() => undefined);

$('toggle-token').addEventListener('click', (e) => {
  const input = $('token');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  e.currentTarget.textContent = show ? '隐藏' : '显示';
  e.currentTarget.setAttribute('aria-pressed', String(show));
});

function showKey(key, okText) {
  $('result-placeholder').hidden = true;
  $('result-ok').textContent = okText;
  $('key-value').textContent = key;
  $('mcp-url').textContent = mcpUrl;
  $('cc-cmd').textContent = `claude mcp add --transport http canvas ${mcpUrl} --header "X-API-Key: ${key}"`;
  $('result').hidden = false;
  const card = $('keycard');
  card.classList.remove('materialize');
  void card.offsetWidth;
  card.classList.add('materialize');
  card.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

$('form-connect').addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = $('connect-error');
  setError(error, '');
  const school = $('school').value.trim();
  const token = $('token').value.trim();
  if (!school) return setError(error, '请填学校的 Canvas 地址'), $('school').focus();
  if (!token) return setError(error, '请粘贴 Canvas 生成的访问令牌'), $('token').focus();
  if (!$('agree').checked) return setError(error, '请先读一下风险提示，并勾选确认'), $('agree').focus();
  try {
    const data = await busy($('connect-submit'), '正在向 Canvas 验证…', () =>
      api('/api/register', { body: { school, token, accessCode: $('code').value.trim() } }),
    );
    $('token').value = '';
    $('token').type = 'password';
    $('toggle-token').textContent = '显示';
    showKey(data.key, data.name ? `已连接 ${data.school}，账号：${data.name}` : `已连接 ${data.school}`);
  } catch (err) {
    setError(error, err.message);
  }
});

// ---------- 管理 ----------
const manageError = $('manage-error');
const manageResult = $('manage-result');

function manageKey() {
  setError(manageError, '');
  const key = $('manage-key').value.trim();
  if (!/^cv[ks]_[A-Za-z0-9_-]{43,800}$/.test(key)) {
    setError(manageError, '连接密钥以 cvk_ 或 cvs_ 开头，请完整粘贴');
    $('manage-key').focus();
    return null;
  }
  return key;
}

function showPanel(build) {
  manageResult.replaceChildren();
  build(manageResult);
  manageResult.hidden = false;
  manageResult.classList.remove('materialize');
  void manageResult.offsetWidth;
  manageResult.classList.add('materialize');
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

$('form-manage').addEventListener('submit', async (e) => {
  e.preventDefault();
  disarmDelete();
  const key = manageKey();
  if (!key) return;
  try {
    const data = await busy($('btn-status'), '检查中…', () => api('/api/status', { key }));
    showPanel((panel) => {
      const list = el('dl');
      const row = (name, value) => list.append(el('dt', name), el('dd', value));
      row('学校', data.school);
      if (data.name) row('账号', data.name);
      row('创建于', data.created);
      row('令牌', data.tokenValid === true ? '有效' : data.tokenValid === false ? '已失效：过期了或被删除了，请删除这个连接后重新创建' : '暂时连不上 Canvas，没法确认');
      panel.append(list);
    });
  } catch (err) {
    manageResult.hidden = true;
    setError(manageError, err.message);
  }
});

$('btn-rotate').addEventListener('click', async () => {
  disarmDelete();
  const key = manageKey();
  if (!key) return;
  try {
    const data = await busy($('btn-rotate'), '更换中…', () => api('/api/rotate', { key }));
    $('manage-key').value = '';
    showPanel((panel) => {
      panel.append(el('p', '旧密钥已失效。这是新的连接密钥，只显示这一次：', 'ok'));
      const value = el('code', data.key, 'keycard-value');
      value.id = 'rotated-key';
      const copy = el('button', '复制密钥', 'primary small');
      copy.type = 'button';
      copy.dataset.copy = 'rotated-key';
      const wrap = el('p');
      wrap.append(value);
      panel.append(wrap, copy, el('p', '记得到 Claude 的连接器设置里，把 X-API-Key 改成这把新密钥。', 'keycard-warn'));
    });
  } catch (err) {
    manageResult.hidden = true;
    setError(manageError, err.message);
  }
});

// 删除不可恢复：第一次点只是“上膛”，再点一次才执行；点别处或 5 秒后自动取消
const deleteButton = $('btn-delete');
let disarmTimer;
function disarmDelete() {
  clearTimeout(disarmTimer);
  deleteButton.classList.remove('armed');
  deleteButton.textContent = '删除连接';
}
deleteButton.addEventListener('click', async () => {
  const key = manageKey();
  if (!key) return disarmDelete();
  if (!deleteButton.classList.contains('armed')) {
    deleteButton.classList.add('armed');
    deleteButton.textContent = '再点一次，确认删除';
    disarmTimer = setTimeout(disarmDelete, 5000);
    return;
  }
  disarmDelete();
  try {
    await busy(deleteButton, '删除中…', () => api('/api/delete', { key }));
    $('manage-key').value = '';
    showPanel((panel) => {
      panel.append(
        el('p', '连接已删除，服务器上的加密文件已经清除。', 'ok'),
        el('p', '建议现在到 Canvas 的 Account → Settings → Approved Integrations 里，把对应的令牌也删掉，并在 Claude 里移除这个连接器。'),
      );
    });
  } catch (err) {
    manageResult.hidden = true;
    setError(manageError, err.message);
  }
});
$('manage-key').addEventListener('input', disarmDelete);
