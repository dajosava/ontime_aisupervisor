const DEFAULT_BASE_URL = (process.env.CHATWOOT_DEFAULT_BASE_URL || 'https://app.ontime.chat')
  .toString()
  .trim()
  .replace(/\/$/, '');

const MAX_CONVERSATION_MESSAGES = parseInt(process.env.MAX_CONVERSATION_MESSAGES || '3000', 10);
const CHATWOOT_MESSAGES_PAGE_SIZE = parseInt(process.env.CHATWOOT_MESSAGES_PAGE_SIZE || '20', 10);
const SUPERVISOR_MAX_CONVERSATIONS = parseInt(process.env.SUPERVISOR_MAX_CONVERSATIONS || '0', 10);
const SUPERVISOR_MAX_CONVERSATION_PAGES = Math.max(1, parseInt(process.env.SUPERVISOR_MAX_CONVERSATION_PAGES || '200', 10));
const CHATWOOT_ACTIVITY_WINDOW_HOURS = Math.max(
  1,
  parseInt(process.env.CHATWOOT_ACTIVITY_WINDOW_HOURS || '24', 10)
);
const CHATWOOT_RECENT_MESSAGES_MAX_PAGES = Math.max(
  3,
  parseInt(process.env.CHATWOOT_RECENT_MESSAGES_MAX_PAGES || '30', 10)
);

function cleanBaseUrl(value) {
  return (value || DEFAULT_BASE_URL).toString().trim().replace(/\/$/, '');
}

function chatwootTokenFrom(req, body = {}) {
  return (
    process.env.CHATWOOT_API_TOKEN ||
    req.headers['api_access_token'] ||
    body.token ||
    body.chatwootToken ||
    ''
  ).toString().trim();
}

async function chatwootApiFetch({ baseUrl, accountId, path, token, logger, logLabel }) {
  const url = `${cleanBaseUrl(baseUrl)}/api/v1/accounts/${accountId}${path}`;
  const label = logLabel || path;
  const started = Date.now();
  logger?.debug('chatwoot_request', { label, method: 'GET', path });

  const response = await fetch(url, {
    headers: {
      api_access_token: token,
      accept: 'application/json'
    }
  });

  const ms = Date.now() - started;

  if (!response.ok) {
    const text = await response.text();
    logger?.error('chatwoot_http_error', {
      label,
      path,
      status: response.status,
      duration_ms: ms,
      body_preview: text.slice(0, 200)
    });
    throw new Error(`Chatwoot HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  const payload = data?.data?.payload || data?.payload;
  logger?.info('chatwoot_response_ok', {
    label,
    path,
    duration_ms: ms,
    items: Array.isArray(payload) ? payload.length : null
  });
  return data;
}

function resolveConversationFetchLimit(limit) {
  const parsed = parseInt(limit, 10);
  if (limit === 'all' || limit === true || parsed === 0) return 0;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 0;
}

function activityWindowSinceUnix(windowHours = CHATWOOT_ACTIVITY_WINDOW_HOURS) {
  return Math.floor(Date.now() / 1000) - windowHours * 3600;
}

function conversationLastActivityUnix(conversation) {
  const ts =
    conversation?.last_activity_at ??
    conversation?.timestamp ??
    conversation?.updated_at ??
    conversation?.last_non_activity_message?.created_at;
  return Number(ts) || 0;
}

function conversationHasRecentActivity(conversation, sinceUnix) {
  return conversationLastActivityUnix(conversation) >= sinceUnix;
}

async function fetchConversationList({ baseUrl, accountId, inboxId, limit, token, status = 'all' }) {
  const perPage = 25;
  const requestedLimit = resolveConversationFetchLimit(limit);
  const fetchAll = requestedLimit <= 0;
  const hardCap = SUPERVISOR_MAX_CONVERSATIONS > 0 ? SUPERVISOR_MAX_CONVERSATIONS : Infinity;
  const effectiveLimit = fetchAll ? hardCap : Math.min(requestedLimit, hardCap);
  const maxPages = fetchAll
    ? SUPERVISOR_MAX_CONVERSATION_PAGES
    : Math.max(1, Math.ceil(effectiveLimit / perPage));
  const conversations = [];

  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams({ page: String(page), status });
    if (inboxId) params.set('inbox_id', String(inboxId));

    const data = await chatwootApiFetch({
      baseUrl,
      accountId,
      token,
      path: `/conversations?${params.toString()}`
    });

    const payload = data?.data?.payload || data?.payload || [];
    if (!payload.length) break;

    for (const conversation of payload) {
      conversations.push(conversation);
      if (!fetchAll && conversations.length >= effectiveLimit) break;
      if (conversations.length >= hardCap) break;
    }

    if (conversations.length >= effectiveLimit && !fetchAll) break;
    if (conversations.length >= hardCap) break;
    if (payload.length < perPage) break;
  }

  return conversations;
}

async function fetchConversationsWithRecentActivity({
  baseUrl,
  accountId,
  inboxId,
  token,
  windowHours = CHATWOOT_ACTIVITY_WINDOW_HOURS,
  logger
}) {
  const sinceUnix = activityWindowSinceUnix(windowHours);
  const perPage = 25;
  const conversations = [];
  let pagesScanned = 0;

  for (let page = 1; page <= SUPERVISOR_MAX_CONVERSATION_PAGES; page++) {
    const params = new URLSearchParams({ page: String(page), status: 'all' });
    if (inboxId) params.set('inbox_id', String(inboxId));

    const data = await chatwootApiFetch({
      baseUrl,
      accountId,
      token,
      path: `/conversations?${params.toString()}`,
      logger,
      logLabel: `conversations_page_${page}`
    });

    const payload = data?.data?.payload || data?.payload || [];
    pagesScanned += 1;
    if (!payload.length) break;

    let recentOnPage = 0;
    for (const conversation of payload) {
      if (conversationHasRecentActivity(conversation, sinceUnix)) {
        conversations.push(conversation);
        recentOnPage += 1;
      }
    }
    logger?.debug('chatwoot_page_filtered', {
      page,
      total_on_page: payload.length,
      recent_on_page: recentOnPage,
      recent_total: conversations.length
    });

    const activityTimes = payload.map(conversationLastActivityUnix).filter(Boolean);
    const oldestInPage = activityTimes.length ? Math.min(...activityTimes) : 0;
    if (oldestInPage > 0 && oldestInPage < sinceUnix) break;
    if (payload.length < perPage) break;
    if (SUPERVISOR_MAX_CONVERSATIONS > 0 && conversations.length >= SUPERVISOR_MAX_CONVERSATIONS) break;
  }

  const capped =
    SUPERVISOR_MAX_CONVERSATIONS > 0
      ? conversations.slice(0, SUPERVISOR_MAX_CONVERSATIONS)
      : conversations;

  return {
    conversations: capped,
    sinceUnix,
    windowHours,
    pages_scanned: pagesScanned
  };
}

async function fetchConversationMessagesPage({
  baseUrl,
  accountId,
  conversationId,
  token,
  before,
  logger,
  logLabel
}) {
  const params = new URLSearchParams();
  if (before != null) params.set('before', String(before));
  const query = params.toString();
  const path = `/conversations/${conversationId}/messages${query ? `?${query}` : ''}`;
  const data = await chatwootApiFetch({
    baseUrl,
    accountId,
    token,
    path,
    logger,
    logLabel: logLabel || `messages_${conversationId}`
  });
  return data?.payload || [];
}

async function fetchAllConversationMessages({ baseUrl, accountId, conversationId, token }) {
  const all = [];
  const seen = new Set();
  let before = null;
  let pages = 0;
  const maxPages = Math.max(5, Math.ceil(MAX_CONVERSATION_MESSAGES / CHATWOOT_MESSAGES_PAGE_SIZE) + 2);

  while (pages < maxPages && all.length < MAX_CONVERSATION_MESSAGES) {
    const batch = await fetchConversationMessagesPage({
      baseUrl,
      accountId,
      conversationId,
      token,
      before
    });
    if (!batch.length) break;

    let oldestInBatch = null;
    let added = 0;

    for (const message of batch) {
      const id = message?.id;
      if (id != null && seen.has(id)) continue;
      if (id != null) seen.add(id);
      all.push(message);
      added += 1;
      if (
        !oldestInBatch ||
        Number(message.created_at || 0) < Number(oldestInBatch.created_at || 0)
      ) {
        oldestInBatch = message;
      }
    }

    if (!added) break;
    if (batch.length < CHATWOOT_MESSAGES_PAGE_SIZE) break;
    if (!oldestInBatch?.id) break;
    if (before === oldestInBatch.id) break;

    before = oldestInBatch.id;
    pages += 1;
  }

  return all.sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0));
}

async function fetchConversationMessages(params) {
  return fetchAllConversationMessages(params);
}

async function fetchRecentConversationMessages({
  baseUrl,
  accountId,
  conversationId,
  token,
  sinceUnix,
  logger
}) {
  const all = [];
  const seen = new Set();
  let before = null;
  let pages = 0;

  while (pages < CHATWOOT_RECENT_MESSAGES_MAX_PAGES) {
    const batch = await fetchConversationMessagesPage({
      baseUrl,
      accountId,
      conversationId,
      token,
      before,
      logger,
      logLabel: `messages_${conversationId}_p${pages + 1}`
    });
    if (!batch.length) break;

    let added = 0;
    let batchEntirelyOlder = true;
    let oldestInBatch = null;

    for (const message of batch) {
      const created = Number(message.created_at || 0);
      if (created > 0 && created < Number(oldestInBatch?.created_at || Infinity)) {
        oldestInBatch = message;
      }
      if (created < sinceUnix) continue;
      batchEntirelyOlder = false;
      const id = message?.id;
      if (id != null && seen.has(id)) continue;
      if (id != null) seen.add(id);
      all.push(message);
      added += 1;
    }

    if (batchEntirelyOlder) break;
    if (!added && batch.length < CHATWOOT_MESSAGES_PAGE_SIZE) break;
    if (batch.length < CHATWOOT_MESSAGES_PAGE_SIZE) break;
    if (!oldestInBatch?.id) break;
    if (before === oldestInBatch.id) break;

    before = oldestInBatch.id;
    pages += 1;
  }

  return all.sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0));
}

async function fetchConversationById({
  baseUrl,
  accountId,
  conversationId,
  token,
  logger,
  logLabel
}) {
  const data = await chatwootApiFetch({
    baseUrl,
    accountId,
    token,
    path: `/conversations/${conversationId}`,
    logger,
    logLabel: logLabel || `conversation_${conversationId}`
  });
  return data?.payload || data?.data?.payload || data;
}

async function fetchMessagesForAnalysis({
  fullHistory = false,
  baseUrl,
  accountId,
  conversationId,
  token,
  sinceUnix,
  logger
}) {
  if (fullHistory) {
    return fetchAllConversationMessages({
      baseUrl,
      accountId,
      conversationId,
      token
    });
  }
  return fetchRecentConversationMessages({
    baseUrl,
    accountId,
    conversationId,
    token,
    sinceUnix,
    logger
  });
}

function conversationAppUrl(baseUrl, accountId, inboxId, conversationId) {
  return `${cleanBaseUrl(baseUrl)}/app/accounts/${accountId}/inbox/${inboxId}/conversations/${conversationId}`;
}

module.exports = {
  DEFAULT_BASE_URL,
  CHATWOOT_ACTIVITY_WINDOW_HOURS,
  CHATWOOT_MESSAGES_PAGE_SIZE,
  MAX_CONVERSATION_MESSAGES,
  SUPERVISOR_MAX_CONVERSATIONS,
  SUPERVISOR_MAX_CONVERSATION_PAGES,
  cleanBaseUrl,
  chatwootTokenFrom,
  chatwootApiFetch,
  activityWindowSinceUnix,
  conversationLastActivityUnix,
  conversationHasRecentActivity,
  fetchConversationList,
  fetchConversationsWithRecentActivity,
  fetchConversationMessages,
  fetchRecentConversationMessages,
  fetchConversationById,
  fetchMessagesForAnalysis,
  conversationAppUrl
};
