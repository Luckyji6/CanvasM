// 调用方是跑在云端的 AI：不需要、也不该上云的 Canvas 数据在这里挡掉或抹掉。

// 路径规则末尾用 (\/|\.|$)：Rails 路由接受 .json 这类格式后缀，不能让 users.json 绕过去
const END = '(\\/|\\.|$)';
const BLOCKED_PATHS = [
  [new RegExp(`^/api/v1/users/[^/]+/(tokens|[^/]*_token)${END}`), 'access tokens'],
  [new RegExp(`^/api/v1/users/[^/]+/communication_channels${END}`), 'email addresses / phone numbers'],
  [new RegExp(`^/api/v1/users/[^/]+/(page_views|history|logins)${END}`), 'browsing and login history'],
  [new RegExp(`^/api/v1/users/[^/]+/(observees|observers)${END}`), 'parent / observer accounts'],
  [new RegExp(`^/api/v1/users/[^/]+/(files|folders|avatars)${END}`), 'personal files and photos'],
  [new RegExp(`^/api/v1/conversations${END}`), 'private inbox messages'],
  [new RegExp(`^/api/v1/(courses|sections)/[^/]+/(users|students|search_users|recent_students|enrollments)${END}`), 'classmate roster'],
  [new RegExp(`^/api/v1/groups/[^/]+/(users|memberships)${END}`), 'classmate roster'],
  [new RegExp(`^/api/v1/search/recipients${END}`), 'classmate roster'],
  [new RegExp(`^/api/v1/accounts${END}`), 'school account administration data'],
  [new RegExp(`^/api/v1/audit${END}`), 'audit logs'],
];

const BLOCKED_GRAPHQL =
  /\b(conversation\w*|communicationChannels?|pageViews?|accessTokens?|usersConnection|enrollmentsConnection|observ\w+)\b/i;

const REDACTED_KEYS = new Set(
  [
    'email', 'primary_email', 'login_id', 'sis_user_id', 'sis_login_id', 'sis_id', 'integration_id',
    'sis_integration_id', 'lti_user_id', 'lti_id', 'secure_params', 'avatar_url', 'avatar_image_url',
    'ics', 'phone', 'phone_number', 'birthdate', 'address', 'remote_ip', 'ip_address', 'context_image',
  ].map((k) => k.replaceAll('_', '')),
);
const REDACTED = '[redacted]';

export function blockedReason(pathname) {
  for (const [re, reason] of BLOCKED_PATHS) if (re.test(pathname)) return reason;
  return null;
}

export const stripGraphqlComments = (query) => query.replace(/#[^\n]*/g, '');

export function blockedGraphqlField(query) {
  return BLOCKED_GRAPHQL.exec(stripGraphqlComments(query))?.[1] ?? null;
}

const SECRET_PARAM =
  /([?&])(verifier|token|access_token|sig|signature|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)=[^&#"'\s<>]*(&?)/gi;

/** 抹掉字符串里的凭据：链接里的 verifier / token / sig 参数、JWT、Canvas 令牌、本站连接密钥、Bearer 串 */
export function scrubSecrets(text) {
  let prev;
  do {
    prev = text;
    text = text.replace(SECRET_PARAM, (_m, sep, _name, amp) => (amp ? sep : ''));
  } while (text !== prev);
  return text
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, REDACTED)
    .replace(/\b\d{3,6}~[A-Za-z0-9]{40,}\b/g, REDACTED)
    .replace(/\bcvk_[A-Za-z0-9_-]{43}/g, REDACTED)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/g, `$1${REDACTED}`);
}

/** 递归处理 Canvas 返回的 JSON */
export function redactJson(value) {
  if (typeof value === 'string') return scrubSecrets(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      const sensitive = REDACTED_KEYS.has(key.toLowerCase().replaceAll('_', ''));
      out[key] = sensitive && v !== null && v !== '' ? REDACTED : redactJson(v);
    }
    return out;
  }
  return value;
}
