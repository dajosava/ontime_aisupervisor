require('dotenv').config();

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const {
  createSupervisorRunLogger,
  getRun,
  listRuns
} = require('./supervisor-logger');

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DEFAULT_BASE_URL = (process.env.CHATWOOT_DEFAULT_BASE_URL || 'https://app.ontime.chat')
  .toString()
  .trim()
  .replace(/\/$/, '');
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const SUPABASE_REPORTS_TABLE = process.env.SUPABASE_REPORTS_TABLE || 'conversation_supervision_reports';
const SUPABASE_SNAPSHOTS_TABLE = process.env.SUPABASE_SNAPSHOTS_TABLE || 'conversation_followup_snapshots';
const FOLLOWUP_TIMEZONE = process.env.FOLLOWUP_TIMEZONE || 'America/Hermosillo';
const FOLLOWUP_STAGES = (process.env.FOLLOWUP_STAGES || 'asesor_ventas,cotizacion_pendiente')
  .split(',')
  .map(stage => stage.trim())
  .filter(Boolean);
/** 0 = incluir todos los mensajes visibles en el transcript (sin recorte por cantidad). */
const MAX_AI_MESSAGES = parseInt(process.env.MAX_AI_MESSAGES || '0', 10);
const MAX_TRANSCRIPT_CHARS = parseInt(process.env.MAX_TRANSCRIPT_CHARS || '100000', 10);
const MAX_CONVERSATION_MESSAGES = parseInt(process.env.MAX_CONVERSATION_MESSAGES || '3000', 10);
const CHATWOOT_MESSAGES_PAGE_SIZE = parseInt(process.env.CHATWOOT_MESSAGES_PAGE_SIZE || '20', 10);
const AI_AGENT_SENDER_NAME = process.env.AI_AGENT_SENDER_NAME || 'Super Admin';
const ARCHITECT_SENDER_NAMES = (process.env.ARCHITECT_SENDER_NAMES || 'Manuel Limon,Kevin Landy,Israel Monge,Abigail Perez')
  .split(',')
  .map(name => name.trim())
  .filter(Boolean);
const INACTIVE_DAYS_THRESHOLD = Math.max(1, parseInt(process.env.INACTIVE_DAYS_THRESHOLD || '2', 10));
/** 0 = sin tope al paginar conversaciones del inbox (solo límite de páginas por seguridad). */
const SUPERVISOR_MAX_CONVERSATIONS = parseInt(process.env.SUPERVISOR_MAX_CONVERSATIONS || '0', 10);
const SUPERVISOR_MAX_CONVERSATION_PAGES = Math.max(1, parseInt(process.env.SUPERVISOR_MAX_CONVERSATION_PAGES || '200', 10));
/** Ventana de actividad reciente a traer de Chatwoot (horas). El histórico largo viene de Supabase. */
const CHATWOOT_ACTIVITY_WINDOW_HOURS = Math.max(
  1,
  parseInt(process.env.CHATWOOT_ACTIVITY_WINDOW_HOURS || '24', 10)
);
const CHATWOOT_RECENT_MESSAGES_MAX_PAGES = Math.max(
  3,
  parseInt(process.env.CHATWOOT_RECENT_MESSAGES_MAX_PAGES || '30', 10)
);
const INACTIVITY_TAG = 'inactiva_interes_real';
const LEGACY_INACTIVITY_TAGS = ['inactiva_25d_interes_real', INACTIVITY_TAG];
const CUSTOMER_INTEREST_KEYWORDS =
  /\b(cotiz|presupuesto|precio|costo|cocina|diseño|diseno|medidas|plano|visita|agendar|modelo|m2|metro|interesad|quiero|necesito|cuando|donde|instalacion|garantia)\b/i;

/** Dominios oficiales de cotización por región (texto en mensajes Chatwoot). */
const QUOTE_URL_REGIONS = {
  obregon: ['obregon.ontimecocinas.com'],
  nogales: ['nogales.ontimecocinas.com', 'nogales.ontimecocibas.com'],
  hermosillo: ['hermosillo.ontimecocinas.com']
};

const INBOX_ID_TO_QUOTE_REGION = {
  '48': 'nogales',
  '49': 'hermosillo',
  '51': 'obregon',
  '52': 'hermosillo'
};

const ALL_QUOTE_DOMAINS = [...new Set(Object.values(QUOTE_URL_REGIONS).flat())];

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  })
  : null;

const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY || '').trim();
const AUTH_EXPLICITLY_OFF = process.env.AUTH_REQUIRED === 'false';
/** Login activo si hay URL de Supabase y no se desactivó con AUTH_REQUIRED=false */
const AUTH_REQUIRED = !AUTH_EXPLICITLY_OFF && Boolean(process.env.SUPABASE_URL);
const AUTH_CLIENT_READY = AUTH_REQUIRED && Boolean(SUPABASE_ANON_KEY);

const STATIC_ROOT = __dirname;
const STATIC_ROUTES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/login.html': 'login.html',
  '/login': 'login.html',
  '/app.js': 'app.js',
  '/auth.js': 'auth.js',
  '/README.md': 'README.md',
  '/supabase-schema.sql': 'supabase-schema.sql',
  '/images/logo.webp': 'images/OIP (1).webp'
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml'
};

function pathnameOnly(reqUrl) {
  try {
    return new URL(reqUrl, 'http://internal').pathname;
  } catch {
    return '/';
  }
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, api_access_token, x-chatwoot-base-url'
  );
}

function sendJson(res, statusCode, payload) {
  setCorsHeaders(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error('Body demasiado grande.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

function getTargetBaseUrl(req) {
  const headerValue = (req.headers['x-chatwoot-base-url'] || '').toString().trim();
  if (!headerValue) return DEFAULT_BASE_URL;
  return headerValue.replace(/\/$/, '');
}

/** Solo cabeceras que Chatwoot necesita; evita reenviar restos del navegador que rompen el upstream. */
function headersForUpstream(req) {
  const out = {};
  const token = req.headers['api_access_token'];
  if (token) out['api_access_token'] = token;
  const accept = req.headers['accept'];
  if (accept) out['accept'] = accept;
  else out['accept'] = 'application/json';
  const ct = req.headers['content-type'];
  if (ct) out['content-type'] = ct;
  return out;
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

function cleanBaseUrl(value) {
  return (value || DEFAULT_BASE_URL).toString().trim().replace(/\/$/, '');
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

/**
 * Lista conversaciones del inbox con actividad en las últimas N horas (p. ej. 24h).
 * Pagina Chatwoot y deja de avanzar cuando una página ya no trae actividad reciente.
 */
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

/**
 * Obtiene el historial completo paginando con cursor `before` (lotes ~20 en Chatwoot).
 */
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

/**
 * Solo mensajes públicos de las últimas N horas (paginación desde lo más reciente).
 */
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

function senderName(message) {
  const sender = message?.sender || {};
  return String(sender.available_name || sender.name || sender.email || '').trim();
}

function uniqueNonEmpty(values) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

function normalizedName(value) {
  return String(value || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function isAiAgentSender(name) {
  return normalizedName(name) === normalizedName(AI_AGENT_SENDER_NAME);
}

function isArchitectSender(name) {
  const normalized = normalizedName(name);
  return ARCHITECT_SENDER_NAMES.some(architectName => normalizedName(architectName) === normalized);
}

function participantType(message) {
  if (message.private) return 'nota_privada';
  if (message.message_type === 0) return 'cliente';
  if (message.message_type === 1) {
    const name = senderName(message);
    if (isAiAgentSender(name)) return 'ai_agent';
    if (isArchitectSender(name)) return 'arquitecto';
    return 'asesor_no_catalogado';
  }
  return 'sistema';
}

function normalizeMessage(message) {
  const role = participantType(message);
  return {
    id: message.id,
    role,
    sender: senderName(message),
    sender_group: role,
    created_at: message.created_at,
    private: Boolean(message.private),
    content: message.content || '[adjunto/sin texto]'
  };
}

function getVisibleMessagesSorted(messages) {
  return messages
    .filter(message => !message.private)
    .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
}

function resolveTranscriptMessageLimit(optionMax) {
  if (optionMax != null && Number.isFinite(optionMax)) return optionMax;
  if (MAX_AI_MESSAGES <= 0) return Infinity;
  return MAX_AI_MESSAGES;
}

function formatTranscriptLine(message) {
  const date = message.created_at
    ? new Date(message.created_at * 1000).toISOString()
    : 'sin_fecha';
  const name = message.sender ? ` (${message.sender})` : '';
  return `[${date}] ${message.role}${name}: ${message.content}`;
}

/**
 * Si el texto supera el límite, conserva inicio + final (proceso de venta + lo reciente).
 */
function applyTranscriptCharLimit(normalized, maxChars) {
  const lines = normalized.map(formatTranscriptLine);
  const full = lines.join('\n');
  if (full.length <= maxChars) {
    return {
      transcript: full,
      truncated: false,
      omitted_count: 0,
      total_messages: normalized.length
    };
  }

  const headCount = Math.min(50, Math.max(15, Math.floor(normalized.length * 0.12)));
  const headMessages = normalized.slice(0, headCount);
  const headText = headMessages.map(formatTranscriptLine).join('\n');
  const omittedMiddle = normalized.length - headCount;
  const separator =
    `\n\n[... ${omittedMiddle} mensajes intermedios omitidos por límite de caracteres; ` +
    'se muestran el inicio de la conversación y el tramo más reciente ...]\n\n';

  const tailBudget = Math.max(2000, maxChars - headText.length - separator.length);
  const tailMessages = [];
  for (let i = normalized.length - 1; i >= headCount; i -= 1) {
    const candidate = [...tailMessages, normalized[i]];
    const candidateText = candidate.map(formatTranscriptLine).join('\n');
    if (candidateText.length > tailBudget && tailMessages.length) break;
    tailMessages.unshift(normalized[i]);
    if (candidateText.length >= tailBudget) break;
  }

  const omittedCount = normalized.length - headMessages.length - tailMessages.length;
  const transcript = `${headText}${separator}${tailMessages.map(formatTranscriptLine).join('\n')}`;

  return {
    transcript,
    truncated: true,
    omitted_count: omittedCount,
    total_messages: normalized.length,
    head_messages: headMessages.length,
    tail_messages: tailMessages.length
  };
}

function buildTranscript(messages, options = {}) {
  const {
    sinceIso,
    maxMessages: optionMax,
    label = 'completo',
    maxChars = MAX_TRANSCRIPT_CHARS
  } = options;
  const totalFetched = messages.length;
  let visible = getVisibleMessagesSorted(messages);

  if (sinceIso) {
    const sinceUnix = Math.floor(new Date(sinceIso).getTime() / 1000);
    visible = visible.filter(message => Number(message.created_at || 0) > sinceUnix);
  } else {
    const limit = resolveTranscriptMessageLimit(optionMax);
    if (Number.isFinite(limit)) visible = visible.slice(-limit);
  }

  const normalized = visible.map(normalizeMessage);
  const limited = applyTranscriptCharLimit(normalized, maxChars);

  return {
    label,
    visible: normalized,
    transcript: limited.transcript,
    message_count: normalized.length,
    truncated: limited.truncated,
    omitted_count: limited.omitted_count || 0,
    total_fetched_messages: totalFetched,
    total_visible_messages: getVisibleMessagesSorted(messages).length,
    transcript_scope: sinceIso ? 'solo_nuevos' : 'historico_completo',
    since_iso: sinceIso || null,
    head_messages: limited.head_messages ?? null,
    tail_messages: limited.tail_messages ?? null
  };
}

function computeMetrics(messages) {
  const visible = messages
    .filter(message => !message.private)
    .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  const inbound = visible.filter(message => message.message_type === 0);
  const outbound = visible.filter(message => message.message_type === 1);
  const aiAgentOutbound = outbound.filter(message => isAiAgentSender(senderName(message)));
  const architectOutbound = outbound.filter(message => isArchitectSender(senderName(message)));
  const uncataloguedOutbound = outbound.filter(message => {
    const name = senderName(message);
    return !isAiAgentSender(name) && !isArchitectSender(name);
  });
  const aiAgentNames = uniqueNonEmpty(aiAgentOutbound.map(senderName));
  const architectNames = uniqueNonEmpty(architectOutbound.map(senderName));
  const uncataloguedNames = uniqueNonEmpty(uncataloguedOutbound.map(senderName));
  const last = visible[visible.length - 1] || null;
  const lastOutbound = outbound[outbound.length - 1] || null;
  const lastInbound = inbound[inbound.length - 1] || null;

  const firstInbound = inbound[0];
  const firstOutboundAfterInbound = firstInbound
    ? outbound.find(message => message.created_at >= firstInbound.created_at)
    : null;
  const firstResponseSeconds = firstInbound && firstOutboundAfterInbound
    ? firstOutboundAfterInbound.created_at - firstInbound.created_at
    : null;

  return {
    message_count: visible.length,
    inbound_count: inbound.length,
    outbound_count: outbound.length,
    ai_agent_outbound_count: aiAgentOutbound.length,
    architect_outbound_count: architectOutbound.length,
    uncatalogued_outbound_count: uncataloguedOutbound.length,
    ai_agent_names: aiAgentNames,
    architect_names: architectNames,
    uncatalogued_outbound_names: uncataloguedNames,
    customer_message_count: inbound.length,
    first_response_seconds: firstResponseSeconds,
    last_message_type: last?.message_type ?? null,
    last_sender_group: last ? participantType(last) : null,
    last_message_at: last?.created_at ? new Date(last.created_at * 1000).toISOString() : null,
    last_outbound_at: lastOutbound?.created_at ? new Date(lastOutbound.created_at * 1000).toISOString() : null,
    last_inbound_at: lastInbound?.created_at ? new Date(lastInbound.created_at * 1000).toISOString() : null,
    last_outbound_sender: lastOutbound ? senderName(lastOutbound) : '',
    last_outbound_sender_group: lastOutbound ? participantType(lastOutbound) : null,
    ai_agent_sender_name: AI_AGENT_SENDER_NAME,
    architect_sender_names: ARCHITECT_SENDER_NAMES
  };
}

function pickLatestIso(...values) {
  let best = null;
  let bestMs = 0;
  for (const value of values) {
    if (!value) continue;
    const ms = new Date(value).getTime();
    if (!Number.isFinite(ms)) continue;
    if (ms >= bestMs) {
      bestMs = ms;
      best = new Date(ms).toISOString();
    }
  }
  return best;
}

function computeInactivityStatus(messages, lastMessageAtIso = null) {
  const visible = getVisibleMessagesSorted(messages);
  const last = visible[visible.length - 1] || null;
  const lastAtIso =
    lastMessageAtIso ||
    (last?.created_at ? new Date(Number(last.created_at) * 1000).toISOString() : null);

  if (!lastAtIso) {
    return {
      days_since_last_interaction: null,
      last_interaction_at: null,
      last_interaction_role: last ? participantType(last) : null
    };
  }

  const lastMs = new Date(lastAtIso).getTime();
  const days = Math.floor((Date.now() - lastMs) / (1000 * 60 * 60 * 24));
  return {
    days_since_last_interaction: days,
    last_interaction_at: lastAtIso,
    last_interaction_role: last ? participantType(last) : null
  };
}

function detectRealCustomerInterest(messages, metrics, quoteDetection, storedHistorical = null) {
  const visible = getVisibleMessagesSorted(messages);
  const inbound = visible.filter(message => message.message_type === 0);
  const inboundTexts = inbound
    .map(message => String(message.content || '').trim())
    .filter(Boolean);
  const signals = [];

  if (quoteDetection?.cotizacion_enviada) signals.push('cotizacion_enviada');
  if ((metrics.customer_message_count || 0) >= 3) signals.push('cliente_activo');
  else if ((metrics.customer_message_count || 0) >= 2) signals.push('cliente_multiples_mensajes');

  const substantiveInbound = inboundTexts.filter(
    text => text.length >= 25 || CUSTOMER_INTEREST_KEYWORDS.test(text)
  );
  if (substantiveInbound.length) signals.push('mensajes_con_intencion_comercial');

  const humanOutbound =
    (metrics.architect_outbound_count || 0) > 0 || (metrics.uncatalogued_outbound_count || 0) > 0;
  if (humanOutbound && inbound.length) signals.push('seguimiento_humano');

  if ((metrics.ai_agent_outbound_count || 0) > 0 && inbound.length >= 2) {
    signals.push('dialogo_ai_y_cliente');
  }

  const storedQuote = storedHistorical?.metrics_snapshot?.quote_detection;
  if (storedQuote?.cotizacion_enviada) signals.push('cotizacion_previa_en_bd');
  const storedCount = Number(storedHistorical?.metrics_snapshot?.message_count || 0);
  if (storedCount >= 3) signals.push('historial_activo_en_bd');
  if (storedHistorical?.stage && !['indefinida', 'bot_lead_inicial'].includes(storedHistorical.stage)) {
    signals.push('etapa_avanzada_en_bd');
  }

  const onlyShortGreeting =
    inbound.length === 1 &&
    (inboundTexts[0] || '').length < 30 &&
    !CUSTOMER_INTEREST_KEYWORDS.test(inboundTexts[0] || '') &&
    !quoteDetection?.cotizacion_enviada &&
    !storedQuote?.cotizacion_enviada &&
    !humanOutbound &&
    storedCount < 2;

  return {
    real_customer_interest: signals.length > 0 && !onlyShortGreeting,
    interest_signals: uniqueNonEmpty(signals),
    excluded_as_low_intent: onlyShortGreeting
  };
}

function buildInactivityTagging(messages, metrics, quoteDetection, storedHistorical = null) {
  const inactivity = computeInactivityStatus(messages, metrics.last_message_at);
  const interest = detectRealCustomerInterest(messages, metrics, quoteDetection, storedHistorical);
  const inactiveThresholdMet =
    Number.isFinite(inactivity.days_since_last_interaction) &&
    inactivity.days_since_last_interaction >= INACTIVE_DAYS_THRESHOLD;
  const tagged = inactiveThresholdMet && interest.real_customer_interest;

  return {
    ...inactivity,
    ...interest,
    inactive_threshold_days: INACTIVE_DAYS_THRESHOLD,
    inactive_threshold_met: inactiveThresholdMet,
    supervisor_tags: tagged ? [INACTIVITY_TAG] : [],
    tagged_inactive_with_interest: tagged
  };
}

function mergeInactivityTagging(analysis, tagging) {
  const next = { ...analysis };
  if (!tagging?.tagged_inactive_with_interest) return next;

  const days = tagging.days_since_last_interaction;
  const tagLabel = `Inactiva ${days}+ días sin interacción · interés comercial real`;
  const detail =
    tagging.interest_signals?.length ? ` (${tagging.interest_signals.join(', ')})` : '';

  next.supervisor_tags = uniqueNonEmpty([
    ...(Array.isArray(next.supervisor_tags) ? next.supervisor_tags : []),
    INACTIVITY_TAG
  ]);
  next.alerts = uniqueNonEmpty([
    ...(Array.isArray(next.alerts) ? next.alerts : []),
    `${tagLabel}${detail}`
  ]);
  next.requires_human_review = true;
  next.missed_followups = true;

  if (['indefinida', 'bot_lead_inicial', 'asesor_ventas'].includes(next.stage)) {
    next.stage = 'oportunidad_inactiva';
  }

  const spa = { ...(next.sales_process_analysis || {}) };
  spa.seguimiento_comercial = spa.seguimiento_comercial || 'ausente';
  spa.proximo_paso_comercial =
    spa.proximo_paso_comercial ||
    `Reactivar conversación: lleva ${days} días sin actividad y hubo interés comercial previo.`;
  next.sales_process_analysis = spa;
  next.recommendation =
    next.recommendation ||
    `Contactar al cliente: ${days} días sin interacción con señales de interés real (${tagging.interest_signals.join(', ')}).`;

  return next;
}

function conversationAppUrl(baseUrl, accountId, inboxId, conversationId) {
  return `${cleanBaseUrl(baseUrl)}/app/accounts/${accountId}/inbox/${inboxId}/conversations/${conversationId}`;
}

function inferQuoteRegionFromBranchName(branchName) {
  const key = normalizedName(branchName);
  if (key.includes('nog')) return 'nogales';
  if (key.includes('obregon') || key.includes('obreg') || key.includes('cenontime')) return 'obregon';
  if (key.includes('hmo') || key.includes('hermosillo') || key.includes('fb hermosillo')) return 'hermosillo';
  return null;
}

function expectedQuoteRegion(inboxId, branchName) {
  const fromInbox = INBOX_ID_TO_QUOTE_REGION[String(inboxId || '').trim()];
  if (fromInbox) return fromInbox;
  return inferQuoteRegionFromBranchName(branchName);
}

function extractMessageSearchText(message) {
  const parts = [];
  if (message?.content) parts.push(String(message.content));
  const attachments = message?.attachments;
  if (Array.isArray(attachments)) {
    for (const attachment of attachments) {
      if (!attachment || typeof attachment !== 'object') continue;
      for (const field of ['data_url', 'file_url', 'thumb_url', 'download_url', 'external_url', 'redirect_url']) {
        if (attachment[field]) parts.push(String(attachment[field]));
      }
    }
  }
  if (message?.content_attributes && typeof message.content_attributes === 'object') {
    try {
      parts.push(JSON.stringify(message.content_attributes));
    } catch {
      // ignorar
    }
  }
  return parts.join('\n');
}

function findQuoteDomainsInText(text) {
  const lower = String(text || '').toLowerCase();
  const hits = [];
  for (const [region, domains] of Object.entries(QUOTE_URL_REGIONS)) {
    for (const domain of domains) {
      if (lower.includes(domain.toLowerCase())) {
        hits.push({ region, domain });
      }
    }
  }
  return hits;
}

function extractQuoteSnippet(text, domain, maxLen = 120) {
  const lower = String(text || '').toLowerCase();
  const idx = lower.indexOf(domain.toLowerCase());
  if (idx < 0) return domain;
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + domain.length + 60);
  let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (snippet.length > maxLen) snippet = `${snippet.slice(0, maxLen - 1)}…`;
  return snippet;
}

/**
 * Detecta cotización enviada buscando dominios oficiales en mensajes (prioriza salientes).
 */
function detectQuoteInMessages(messages, inboxId, branchName) {
  const expectedRegion = expectedQuoteRegion(inboxId, branchName);
  const visible = getVisibleMessagesSorted(messages);
  const detections = [];

  for (const message of visible) {
    const text = extractMessageSearchText(message);
    if (!text.trim()) continue;
    const hits = findQuoteDomainsInText(text);
    for (const hit of hits) {
      detections.push({
        message_id: message.id,
        created_at: message.created_at ? unixToIso(message.created_at) : null,
        message_type: message.message_type,
        sender: senderName(message),
        sender_group: participantType(message),
        is_outbound: message.message_type === 1,
        region: hit.region,
        domain: hit.domain,
        snippet: extractQuoteSnippet(text, hit.domain)
      });
    }
  }

  const outboundQuotes = detections.filter(item => item.is_outbound);
  const pool = outboundQuotes.length ? outboundQuotes : detections;
  const firstOutbound = outboundQuotes[0] || null;
  const firstAny = pool[0] || null;
  const primary = firstOutbound || firstAny;
  const cotizacionEnviada = pool.length > 0;

  return {
    cotizacion_enviada: cotizacionEnviada,
    expected_region: expectedRegion,
    matches_branch_expected: !expectedRegion || !primary || primary.region === expectedRegion,
    cotizacion_region: primary?.region || null,
    cotizacion_domain: primary?.domain || null,
    cotizacion_sent_at: primary?.created_at || null,
    cotizacion_sent_by: primary?.sender || null,
    cotizacion_message_id: primary?.message_id || null,
    cotizacion_detection_method: 'url_pattern',
    cotizacion_evidence: primary
      ? `Dominio oficial ${primary.domain} (${primary.region}) en mensaje ${primary.is_outbound ? 'saliente' : 'entrante'} · ${primary.sender}`
      : '',
    outbound_quote_link_count: outboundQuotes.length,
    total_quote_link_count: detections.length,
    quote_domains_catalog: ALL_QUOTE_DOMAINS,
    detections
  };
}

function mergeQuoteDetectionIntoAnalysis(analysis, quoteDetection) {
  const next = { ...analysis };
  next.sales_process_analysis = { ...(next.sales_process_analysis || {}) };
  const spa = next.sales_process_analysis;

  next.quote_detection = quoteDetection;

  if (!quoteDetection?.cotizacion_enviada) {
    spa.cotizacion_detection_source = spa.cotizacion_enviada
      ? (spa.cotizacion_detection_source || 'ai_inference')
      : 'url_pattern_not_found';
    if (!spa.cotizacion_enviada) spa.cotizacion_enviada = false;
    next.sales_process_analysis = spa;
    return next;
  }

  spa.cotizacion_enviada = true;
  spa.cotizacion_detection_source = 'url_pattern';
  spa.cotizacion_url_domain = quoteDetection.cotizacion_domain;
  spa.cotizacion_region = quoteDetection.cotizacion_region;
  spa.cotizacion_sent_at = quoteDetection.cotizacion_sent_at;
  spa.cotizacion_evidence = quoteDetection.cotizacion_evidence || spa.cotizacion_evidence;
  if (!spa.funnel_stage || spa.funnel_stage === 'asesor_ventas' || spa.funnel_stage === 'indefinida') {
    spa.funnel_stage = 'cotizacion_enviada';
  }

  if (['bot_lead_inicial', 'asesor_ventas', 'indefinida'].includes(next.stage)) {
    next.stage = 'cotizacion_pendiente';
  }

  if (!quoteDetection.matches_branch_expected && quoteDetection.expected_region) {
    next.alerts = [...(Array.isArray(next.alerts) ? next.alerts : []), `Cotización con dominio ${quoteDetection.cotizacion_region}; sucursal esperada: ${quoteDetection.expected_region}`];
  }

  next.sales_process_analysis = spa;
  return next;
}

function analysisJsonSchemaPrompt() {
  return `Devuelve SOLO JSON válido con esta estructura:
{
  "stage": "bot_lead_inicial|asesor_ventas|cotizacion_pendiente|diseno|posventa|indefinida",
  "risk_level": "bajo|medio|alto|grave",
  "score_general": 0,
  "customer_sentiment": "positivo|neutral|molesto|grave",
  "alerts": ["texto corto"],
  "strengths": ["texto corto"],
  "improvement_opportunities": ["texto corto"],
  "differentiators_detected": ["Entrega en 15 días", "Garantía de 5 años"],
  "missed_followups": false,
  "abandoned_chat": false,
  "requires_human_review": false,
  "summary": "resumen ejecutivo",
  "recommendation": "siguiente acción recomendada",
  "ai_agent_analysis": {
    "present": false,
    "score": 0,
    "summary": "análisis específico del AI agent",
    "strengths": ["texto corto"],
    "issues": ["texto corto"],
    "recommendation": "mejora para el AI agent"
  },
  "architect_analysis": {
    "present": false,
    "architect_names": ["nombre"],
    "score": 0,
    "summary": "análisis específico del arquitecto humano",
    "strengths": ["texto corto"],
    "issues": ["texto corto"],
    "recommendation": "mejora para el arquitecto"
  },
  "handoff_analysis": {
    "quality": "no_aplica|buena|regular|mala",
    "summary": "si el paso de AI agent a arquitecto fue claro o tuvo problemas"
  },
  "sales_process_analysis": {
    "funnel_stage": "lead|calificacion|asesor_ventas|cotizacion_enviada|negociacion|cierre|posventa|indefinida",
    "cotizacion_enviada": false,
    "cotizacion_evidence": "cita breve o vacío si no aplica",
    "esperando_respuesta_cliente": false,
    "seguimiento_comercial": "adecuado|insuficiente|ausente|no_aplica",
    "seguimiento_resumen": "evaluación del seguimiento día a día y post-cotización",
    "atencion_calidad": "excelente|buena|regular|mala",
    "atencion_resumen": "calidad de atención al cliente en el proceso",
    "cambios_desde_ultimo_analisis": "qué cambió desde el análisis previo o snapshots",
    "proceso_venta_resumen": "narrativa del proceso de venta de punta a punta",
    "proximo_paso_comercial": "acción concreta recomendada para cerrar o avanzar"
  }
}
Reglas:
- score_general debe ser número entero de 0 a 100.
- En esta cuenta, el usuario "${AI_AGENT_SENDER_NAME}" representa al AI Agent de On Time Cocinas.
- Los arquitectos humanos oficiales son: ${ARCHITECT_SENDER_NAMES.join(', ')}. Solo esos usuarios deben evaluarse como arquitecto humano directo con el cliente.
- Si aparece un mensaje saliente de otro usuario no listado, trátalo como "asesor no catalogado" y no lo mezcles con el análisis de arquitecto.
- Separa explícitamente lo que hizo el AI Agent y lo que hizo el arquitecto. No mezcles responsabilidades: si una falla ocurrió antes del traspaso, va en ai_agent_analysis; si ocurrió durante atención humana, va en architect_analysis.
- Si no hay mensajes de AI Agent o no hay mensajes de arquitecto, usa present=false y explica "sin intervención" en summary.
- Marca risk_level grave si hay amenaza de cancelar, devolución, demanda, Profeco, redes sociales, garantía sin solución, cliente que ya pagó sin atención o múltiples insistencias sin respuesta.
- Evalúa calidad de atención, velocidad percibida, seguimiento comercial, etapa y oportunidades perdidas.
- Usa sales_process_analysis para evaluar el proceso de venta: atención, envío de cotización, espera de aceptación del cliente y seguimiento posterior.
- Si hay enrichment.previous_report o enrichment.snapshot_timeline, compáralos con el transcript_new_since_last_analysis para detectar cambios reales.
- Si cotizacion_enviada=true, evalúa si hubo seguimiento humano adecuado mientras el cliente no responde.
- Si enrichment.quote_detection.cotizacion_enviada es true (método url_pattern), la cotización YA fue enviada: no marques cotizacion_enviada=false. Usa la evidencia del dominio oficial.
- Dominios oficiales de cotización: ${ALL_QUOTE_DOMAINS.join(', ')}.
- No inventes datos que no aparezcan en la conversación.`;
}

async function fetchPreviousReport(conversationId) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from(SUPABASE_REPORTS_TABLE)
    .select('*')
    .eq('conversation_id', Number(conversationId))
    .maybeSingle();
  if (error) throw new Error(`Supabase report previo: ${error.message}`);
  return data || null;
}

function buildStoredHistoricalContext(previousReport) {
  if (!previousReport) return null;
  const metrics = previousReport.metrics || {};
  const spa =
    previousReport.raw_analysis?.sales_process_analysis ||
    metrics.sales_process_analysis ||
    {};
  const narrative = uniqueNonEmpty([
    previousReport.summary,
    previousReport.recommendation,
    spa.proceso_venta_resumen,
    spa.seguimiento_resumen,
    spa.proximo_paso_comercial,
    previousReport.ai_agent_summary,
    previousReport.architect_summary
  ]).join('\n');

  return {
    source: 'supabase',
    analyzed_at: previousReport.analyzed_at,
    stage: previousReport.stage,
    risk_level: previousReport.risk_level,
    score_general: previousReport.score_general,
    summary: previousReport.summary,
    recommendation: previousReport.recommendation,
    customer_sentiment: previousReport.customer_sentiment,
    missed_followups: previousReport.missed_followups,
    alerts: previousReport.alerts || [],
    ai_agent_summary: previousReport.ai_agent_summary,
    architect_summary: previousReport.architect_summary,
    metrics_snapshot: {
      message_count: metrics.message_count,
      inbound_count: metrics.inbound_count,
      outbound_count: metrics.outbound_count,
      last_message_at: metrics.last_message_at,
      last_inbound_at: metrics.last_inbound_at,
      last_outbound_at: metrics.last_outbound_at,
      quote_detection: metrics.quote_detection || null,
      inactivity_tagging: metrics.inactivity_tagging || null,
      supervisor_tags: metrics.supervisor_tags || []
    },
    sales_process_analysis: spa,
    narrative_for_ai: narrative
  };
}

function mergeMetricsForAnalysis(storedMetrics, recentMessages, windowHours) {
  const recent = computeMetrics(recentMessages);
  if (!storedMetrics || !Object.keys(storedMetrics).length) {
    return {
      ...recent,
      fetch_mode: 'solo_ultimas_horas_chatwoot',
      chatwoot_activity_window_hours: windowHours,
      messages_fetched_from_chatwoot: recentMessages.length
    };
  }

  const stored = { ...storedMetrics };
  const lastMessageAt = pickLatestIso(stored.last_message_at, recent.last_message_at);
  return {
    ...stored,
    fetch_mode: 'bd_historico_mas_ultimas_horas_chatwoot',
    chatwoot_activity_window_hours: windowHours,
    messages_fetched_from_chatwoot: recentMessages.length,
    recent_window: recent,
    new_messages_in_fetch_window: recent.message_count,
    last_message_at: lastMessageAt,
    last_inbound_at: pickLatestIso(stored.last_inbound_at, recent.last_inbound_at),
    last_outbound_at: pickLatestIso(stored.last_outbound_at, recent.last_outbound_at),
    message_count: Math.max(Number(stored.message_count) || 0, Number(recent.message_count) || 0),
    inbound_count: Math.max(Number(stored.inbound_count) || 0, Number(recent.inbound_count) || 0),
    outbound_count: Math.max(Number(stored.outbound_count) || 0, Number(recent.outbound_count) || 0),
    ai_agent_outbound_count: Math.max(
      Number(stored.ai_agent_outbound_count) || 0,
      Number(recent.ai_agent_outbound_count) || 0
    ),
    architect_outbound_count: Math.max(
      Number(stored.architect_outbound_count) || 0,
      Number(recent.architect_outbound_count) || 0
    ),
    ai_agent_names: uniqueNonEmpty([...(stored.ai_agent_names || []), ...(recent.ai_agent_names || [])]),
    architect_names: uniqueNonEmpty([...(stored.architect_names || []), ...(recent.architect_names || [])]),
    uncatalogued_outbound_names: uniqueNonEmpty([
      ...(stored.uncatalogued_outbound_names || []),
      ...(recent.uncatalogued_outbound_names || [])
    ])
  };
}

function mergeQuoteDetectionWithStored(recentDetection, storedHistorical) {
  const stored = storedHistorical?.metrics_snapshot?.quote_detection;
  if (!stored?.cotizacion_enviada) return recentDetection;
  if (recentDetection?.cotizacion_enviada) return recentDetection;
  return { ...stored, detection_source: 'bd_previo' };
}

async function fetchSnapshotHistory(conversationId, limit = 14) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from(SUPABASE_SNAPSHOTS_TABLE)
    .select('*')
    .eq('conversation_id', Number(conversationId))
    .order('snapshot_date', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Supabase snapshots histórico: ${error.message}`);
  return (data || []).reverse();
}

function summarizeSnapshotForAi(snapshot) {
  if (!snapshot) return null;
  return {
    snapshot_date: snapshot.snapshot_date,
    stage: snapshot.stage,
    message_count: snapshot.message_count,
    human_outbound_today: snapshot.human_outbound_today,
    human_outbound_count: snapshot.human_outbound_count,
    last_message_at: snapshot.last_message_at,
    last_human_outbound_at: snapshot.last_human_outbound_at,
    last_inbound_at: snapshot.last_inbound_at,
    cliente_sin_respuesta: Boolean(snapshot.metrics?.cliente_sin_respuesta)
  };
}

function metricsAsTodaySnapshot(metrics, snapshotDate) {
  return {
    snapshot_date: snapshotDate,
    message_count: metrics.message_count || 0,
    human_outbound_today: Boolean(metrics.human_outbound_today),
    last_message_at: metrics.last_message_at || null,
    last_human_outbound_at: metrics.last_human_outbound_at || null,
    last_inbound_at: metrics.last_inbound_at || null,
    metrics
  };
}

function buildAnalysisEnrichment({
  recentMessages,
  metrics,
  previousReport,
  snapshotHistory,
  quoteDetection,
  inactivityTagging,
  storedHistorical,
  activityWindowHours
}) {
  const snapshotDate = calendarDateInTimezone();
  const yesterdayDate = addCalendarDays(snapshotDate, -1);
  const history = snapshotHistory || [];
  const todaySnap = history.find(snap => snap.snapshot_date === snapshotDate) || null;
  const yesterdaySnap = history.find(snap => snap.snapshot_date === yesterdayDate) || null;
  const previousAnalyzedAt = previousReport?.analyzed_at || null;
  const previousMetrics = previousReport?.metrics || {};
  const windowHours = activityWindowHours || CHATWOOT_ACTIVITY_WINDOW_HOURS;

  const transcriptRecent = buildTranscript(recentMessages, {
    label: `ultimas_${windowHours}h_chatwoot`
  });
  const transcriptSinceLastAnalysis = previousAnalyzedAt
    ? buildTranscript(recentMessages, {
      sinceIso: previousAnalyzedAt,
      label: 'nuevo_desde_ultimo_analisis'
    })
    : buildTranscript(recentMessages, { label: 'nuevo_desde_ultimo_analisis', maxMessages: 0 });

  const transcriptFromDb = storedHistorical?.narrative_for_ai
    ? {
      label: 'historico_resumido_bd',
      transcript: storedHistorical.narrative_for_ai,
      message_count: 0,
      truncated: false,
      transcript_scope: 'resumen_analisis_previo_supabase'
    }
    : null;

  const pseudoTodaySnap = todaySnap || metricsAsTodaySnapshot(metrics, snapshotDate);
  const followupTracking = computeFollowupDiff({
    report: previousReport || { stage: 'indefinida' },
    todaySnap: pseudoTodaySnap,
    yesterdaySnap
  });

  const hasDbHistory = Boolean(storedHistorical);
  const analysisMode = hasDbHistory
    ? 'incremental_bd_mas_chatwoot_reciente'
    : transcriptRecent.message_count
      ? 'analisis_inicial_solo_ventana_reciente'
      : 'analisis_inicial';

  return {
    analysis_mode: analysisMode,
    timezone: FOLLOWUP_TIMEZONE,
    snapshot_date: snapshotDate,
    chatwoot_fetch: {
      activity_window_hours: windowHours,
      messages_fetched: recentMessages.length,
      strategy: hasDbHistory
        ? 'mensajes_recientes_chatwoot_mas_contexto_supabase'
        : 'solo_mensajes_recientes_chatwoot'
    },
    stored_historical: storedHistorical,
    previous_report: previousReport
      ? {
        analyzed_at: previousReport.analyzed_at,
        stage: previousReport.stage,
        risk_level: previousReport.risk_level,
        score_general: previousReport.score_general,
        summary: previousReport.summary,
        recommendation: previousReport.recommendation,
        missed_followups: previousReport.missed_followups,
        message_count_at_analysis: previousMetrics.message_count || null
      }
      : null,
    snapshot_timeline: history.map(summarizeSnapshotForAi).filter(Boolean),
    followup_tracking: followupTracking,
    activity_delta: {
      message_count_now: metrics.message_count || 0,
      message_count_at_last_analysis: previousMetrics.message_count || 0,
      message_count_delta: (metrics.message_count || 0) - (previousMetrics.message_count || 0),
      new_messages_in_chatwoot_window: transcriptRecent.message_count,
      new_messages_since_last_analysis: transcriptSinceLastAnalysis.message_count,
      has_new_activity: transcriptRecent.message_count > 0
    },
    conversation_history: {
      messages_fetched_from_chatwoot_recent: recentMessages.length,
      has_stored_history_in_supabase: hasDbHistory,
      transcript_historico_bd: transcriptFromDb
        ? { chars: transcriptFromDb.transcript.length }
        : null,
      transcript_reciente_chatwoot: {
        messages_in_transcript: transcriptRecent.message_count,
        truncated: transcriptRecent.truncated
      }
    },
    transcripts: {
      historico_resumido_bd: transcriptFromDb,
      ultimas_horas_chatwoot: transcriptRecent,
      nuevo_desde_ultimo_analisis: transcriptSinceLastAnalysis
    },
    quote_detection: quoteDetection || { cotizacion_enviada: false },
    inactivity_tagging: inactivityTagging || null,
    analysis_instructions: [
      `Solo se trajeron de Chatwoot los mensajes de las últimas ${windowHours} horas.`,
      hasDbHistory
        ? 'El contexto histórico largo está en stored_historical y transcripts.historico_resumido_bd (análisis previo en Supabase). No asumas que falta historial si hay datos en BD.'
        : 'No hay reporte previo en Supabase: evalúa con el transcript de la ventana reciente.',
      'Prioriza transcripts.ultimas_horas_chatwoot y transcripts.nuevo_desde_ultimo_analisis para cambios recientes.',
      'Cruza activity_delta y snapshot_timeline para seguimiento día a día.',
      'En sales_process_analysis documenta cotización, espera del cliente y seguimiento comercial.',
      quoteDetection?.cotizacion_enviada
        ? `COTIZACIÓN CONFIRMADA por URL (${quoteDetection.cotizacion_domain}): evalúa seguimiento post-envío y si el cliente ya respondió.`
        : 'No se detectó URL oficial de cotización en mensajes recientes; usa historial BD si indica cotización previa.'
    ]
  };
}

async function analyzeWithOpenAI({
  conversation,
  contact,
  messages,
  metrics,
  enrichment,
  baseUrl,
  accountId,
  branchName,
  inboxId,
  logger
}) {
  if (!openai) {
    throw new Error('OPENAI_API_KEY no está configurada.');
  }

  const prompt = {
    context: {
      business: 'On Time Cocinas',
      branch: branchName || '',
      inbox_id: inboxId || conversation.inbox_id || '',
      account_id: accountId,
      conversation_id: conversation.id,
      conversation_url: conversationAppUrl(baseUrl, accountId, conversation.inbox_id || inboxId, conversation.id),
      status: conversation.status || '',
      customer: {
        id: contact.id || null,
        name: contact.name || '',
        email: contact.email || '',
        phone: contact.phone_number || ''
      },
      metrics
    },
    participant_rules: {
      ai_agent_sender_name: AI_AGENT_SENDER_NAME,
      architect_sender_names: ARCHITECT_SENDER_NAMES,
      ai_agent_rule: `Todo mensaje saliente enviado por "${AI_AGENT_SENDER_NAME}" pertenece al AI Agent de On Time Cocinas.`,
      architect_rule: `Solo estos usuarios salientes pertenecen a arquitectos humanos: ${ARCHITECT_SENDER_NAMES.join(', ')}.`,
      uncatalogued_rule: 'Mensajes salientes de otros usuarios son asesor_no_catalogado y no deben contarse como arquitecto.'
    },
    participant_breakdown: {
      ai_agent_names_detected: metrics.ai_agent_names || [],
      architect_names_detected: metrics.architect_names || [],
      uncatalogued_outbound_names_detected: metrics.uncatalogued_outbound_names || [],
      ai_agent_outbound_count: metrics.ai_agent_outbound_count || 0,
      architect_outbound_count: metrics.architect_outbound_count || 0,
      uncatalogued_outbound_count: metrics.uncatalogued_outbound_count || 0
    },
    enrichment: enrichment || null
  };

  const systemContent =
    'Eres un supervisor de calidad comercial para On Time Cocinas. Analizas conversaciones de Chatwoot con contexto histórico, snapshots de seguimiento y mensajes nuevos. Evalúas proceso de venta, atención, cotización y seguimiento. No respondes al cliente.';
  const userContent = `${analysisJsonSchemaPrompt()}\n\nCONVERSACION Y CONTEXTO:\n${JSON.stringify(prompt, null, 2)}`;

  const payloadStats = logger?.logLlmPayload('analyze_conversation', {
    system: systemContent,
    user: userContent
  }) || null;

  logger?.stepStart('openai_chat_completion', {
    conversation_id: conversation.id,
    model: OPENAI_MODEL,
    ...payloadStats
  });

  const openaiStarted = Date.now();
  let completion;
  try {
    completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: userContent }
      ]
    });
  } catch (err) {
    logger?.error('openai_request_failed', {
      conversation_id: conversation.id,
      duration_ms: Date.now() - openaiStarted,
      error: err.message,
      code: err.code || null,
      status: err.status || null
    });
    logger?.stepEnd('openai_chat_completion', { ok: false });
    throw err;
  }

  const openaiMs = Date.now() - openaiStarted;
  const usage = completion.usage || {};
  logger?.stepEnd('openai_chat_completion', {
    ok: true,
    duration_ms: openaiMs,
    prompt_tokens: usage.prompt_tokens ?? null,
    completion_tokens: usage.completion_tokens ?? null,
    total_tokens: usage.total_tokens ?? null
  });

  if (openaiMs > 60000) {
    logger?.warn('openai_slow_response', { conversation_id: conversation.id, duration_ms: openaiMs });
  }

  const raw = completion.choices?.[0]?.message?.content || '{}';
  try {
    return JSON.parse(raw);
  } catch (err) {
    logger?.error('openai_json_parse_failed', {
      conversation_id: conversation.id,
      raw_preview: raw.slice(0, 300)
    });
    throw new Error(`OpenAI devolvió JSON inválido: ${err.message}`);
  }
}

function rowForReport({ conversation, contact, messages, metrics, analysis, baseUrl, accountId, branchName, inboxId }) {
  const actualInboxId = conversation.inbox_id || inboxId;
  const aiAgentAnalysis = analysis.ai_agent_analysis || {};
  const architectAnalysis = analysis.architect_analysis || {};
  const handoffAnalysis = analysis.handoff_analysis || {};
  const assigneeName = String(conversation.meta?.assignee?.name || '').trim();
  const computedAiAgentPresent = (metrics.ai_agent_outbound_count || 0) > 0;
  const computedArchitectPresent = (metrics.architect_outbound_count || 0) > 0;
  const computedArchitectNames = uniqueNonEmpty([
    ...(metrics.architect_names || []),
    computedArchitectPresent && isArchitectSender(assigneeName) ? assigneeName : ''
  ]);
  const computedAiAgentNames = uniqueNonEmpty([
    ...(metrics.ai_agent_names || []),
    computedAiAgentPresent ? AI_AGENT_SENDER_NAME : ''
  ]);
  const aiAgentPresent = computedAiAgentPresent || Boolean(aiAgentAnalysis.present);
  const architectPresent = computedArchitectPresent || Boolean(architectAnalysis.present);
  const aiAgentSummary = aiAgentAnalysis.summary ||
    (aiAgentPresent
      ? `Intervención detectada del AI Agent (${computedAiAgentNames.join(', ') || AI_AGENT_SENDER_NAME}) con ${metrics.ai_agent_outbound_count || 0} mensajes salientes.`
      : 'Sin intervención detectada del AI Agent.');
  const architectSummary = architectAnalysis.summary ||
    (architectPresent
      ? `Intervención detectada de arquitecto humano (${computedArchitectNames.join(', ') || 'sin nombre identificado'}) con ${metrics.architect_outbound_count || 0} mensajes salientes.`
      : 'Sin intervención detectada de arquitecto humano.');
  const handoffQuality = handoffAnalysis.quality ||
    (aiAgentPresent && architectPresent ? 'pendiente_revision' : 'no_aplica');
  const handoffSummary = handoffAnalysis.summary ||
    (aiAgentPresent && architectPresent
      ? 'La conversación contiene intervención del AI Agent y de al menos un arquitecto humano; revisar si el traspaso fue claro y sin pérdida de contexto.'
      : '');
  return {
    analyzed_at: new Date().toISOString(),
    chatwoot_account_id: Number(accountId),
    conversation_id: Number(conversation.id),
    conversation_url: conversationAppUrl(baseUrl, accountId, actualInboxId, conversation.id),
    inbox_id: actualInboxId != null ? Number(actualInboxId) : null,
    inbox_name: conversation.meta?.channel || `Inbox ${actualInboxId || ''}`.trim(),
    branch_name: branchName || '',
    channel_name: conversation.meta?.channel || '',
    status: conversation.status || '',
    contact_id: contact.id || null,
    contact_name: contact.name || '',
    contact_phone: contact.phone_number || '',
    contact_email: contact.email || '',
    assignee_name: assigneeName || metrics.last_outbound_sender || '',
    stage: analysis.stage || 'indefinida',
    risk_level: analysis.risk_level || 'medio',
    score_general: Number.isFinite(Number(analysis.score_general)) ? Number(analysis.score_general) : null,
    customer_sentiment: analysis.customer_sentiment || '',
    alerts: analysis.alerts || [],
    strengths: analysis.strengths || [],
    improvement_opportunities: analysis.improvement_opportunities || [],
    differentiators_detected: analysis.differentiators_detected || [],
    missed_followups: Boolean(analysis.missed_followups),
    abandoned_chat: Boolean(analysis.abandoned_chat),
    requires_human_review: Boolean(analysis.requires_human_review),
    summary: analysis.summary || '',
    recommendation: analysis.recommendation || '',
    ai_agent_present: aiAgentPresent,
    ai_agent_score: Number.isFinite(Number(aiAgentAnalysis.score)) ? Number(aiAgentAnalysis.score) : null,
    ai_agent_summary: aiAgentSummary,
    ai_agent_strengths: aiAgentAnalysis.strengths || [],
    ai_agent_issues: aiAgentAnalysis.issues || [],
    ai_agent_recommendation: aiAgentAnalysis.recommendation || '',
    architect_present: architectPresent,
    architect_names: uniqueNonEmpty([...(architectAnalysis.architect_names || []), ...computedArchitectNames]),
    architect_score: Number.isFinite(Number(architectAnalysis.score)) ? Number(architectAnalysis.score) : null,
    architect_summary: architectSummary,
    architect_strengths: architectAnalysis.strengths || [],
    architect_issues: architectAnalysis.issues || [],
    architect_recommendation: architectAnalysis.recommendation || '',
    handoff_quality: handoffQuality,
    handoff_summary: handoffSummary,
    ai_agent_outbound_count: metrics.ai_agent_outbound_count || 0,
    architect_outbound_count: metrics.architect_outbound_count || 0,
    metrics: {
      ...metrics,
      enrichment_mode: analysis.sales_process_analysis ? 'con_historial' : 'estandar',
      new_messages_at_analysis: metrics.new_messages_at_analysis ?? null,
      quote_detection: analysis.quote_detection || metrics.quote_detection || null
    },
    ai_model: OPENAI_MODEL,
    raw_analysis: analysis
  };
}

async function storeReports(rows) {
  if (!supabase) return { stored: false, count: 0 };
  const { error } = await supabase
    .from(SUPABASE_REPORTS_TABLE)
    .upsert(rows, { onConflict: 'conversation_id' });
  if (error) throw new Error(`Supabase: ${error.message}`);
  return { stored: true, count: rows.length };
}

function calendarDateInTimezone(date = new Date(), timeZone = FOLLOWUP_TIMEZONE) {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(date);
}

function addCalendarDays(dateStr, days) {
  const base = new Date(`${dateStr}T12:00:00`);
  base.setDate(base.getDate() + days);
  return calendarDateInTimezone(base);
}

function unixToIso(unixSeconds) {
  if (!unixSeconds) return null;
  return new Date(Number(unixSeconds) * 1000).toISOString();
}

function isUnixOnCalendarDate(unixSeconds, dateStr) {
  if (!unixSeconds) return false;
  return calendarDateInTimezone(new Date(Number(unixSeconds) * 1000)) === dateStr;
}

function isHumanOutboundMessage(message) {
  const group = participantType(message);
  return group === 'arquitecto' || group === 'asesor_no_catalogado';
}

function extendMetricsWithFollowup(messages, snapshotDate, baseMetrics = null) {
  const visible = messages
    .filter(message => !message.private)
    .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  const outbound = visible.filter(message => message.message_type === 1);
  const humanOutbound = outbound.filter(isHumanOutboundMessage);

  let lastHumanOutboundAt = null;
  let lastHumanUnix = 0;
  let humanOutboundToday = false;

  for (const message of humanOutbound) {
    const unix = Number(message.created_at || 0);
    if (unix > lastHumanUnix) {
      lastHumanUnix = unix;
      lastHumanOutboundAt = unixToIso(unix);
    }
    if (isUnixOnCalendarDate(unix, snapshotDate)) humanOutboundToday = true;
  }

  const recent = computeMetrics(messages);
  const base = baseMetrics || recent;
  const lastInboundAt = base.last_inbound_at ? new Date(base.last_inbound_at).getTime() : 0;
  const lastOutboundAt = base.last_outbound_at ? new Date(base.last_outbound_at).getTime() : 0;
  const clienteSinRespuesta = lastInboundAt > 0 && lastInboundAt >= lastOutboundAt;

  return {
    ...base,
    human_outbound_count: Math.max(
      Number(base.human_outbound_count) || 0,
      humanOutbound.length
    ),
    human_outbound_today: humanOutboundToday || Boolean(base.human_outbound_today),
    last_human_outbound_at: pickLatestIso(base.last_human_outbound_at, lastHumanOutboundAt),
    cliente_sin_respuesta: clienteSinRespuesta
  };
}

function rowForSnapshot({ report, metrics, snapshotDate, baseUrl, accountId }) {
  const inboxId = report.inbox_id || null;
  const conversationId = Number(report.conversation_id);
  return {
    snapshot_date: snapshotDate,
    captured_at: new Date().toISOString(),
    chatwoot_account_id: Number(report.chatwoot_account_id || accountId),
    conversation_id: conversationId,
    conversation_url: report.conversation_url ||
      conversationAppUrl(baseUrl, accountId, inboxId, conversationId),
    inbox_id: inboxId != null ? Number(inboxId) : null,
    branch_name: report.branch_name || '',
    contact_id: report.contact_id || null,
    contact_name: report.contact_name || '',
    contact_phone: report.contact_phone || '',
    stage: report.stage || 'indefinida',
    risk_level: report.risk_level || null,
    message_count: metrics.message_count || 0,
    inbound_count: metrics.inbound_count || 0,
    outbound_count: metrics.outbound_count || 0,
    human_outbound_count: metrics.human_outbound_count || 0,
    human_outbound_today: Boolean(metrics.human_outbound_today),
    last_message_at: metrics.last_message_at || null,
    last_outbound_at: metrics.last_outbound_at || null,
    last_inbound_at: metrics.last_inbound_at || null,
    last_human_outbound_at: metrics.last_human_outbound_at || null,
    last_outbound_sender_group: metrics.last_outbound_sender_group || null,
    metrics
  };
}

async function fetchReportsForFollowup({ inboxId, stages, limit }) {
  if (!supabase) throw new Error('Supabase no está configurado.');
  let query = supabase
    .from(SUPABASE_REPORTS_TABLE)
    .select('*')
    .in('stage', stages)
    .order('analyzed_at', { ascending: false })
    .limit(limit);

  if (inboxId) query = query.eq('inbox_id', Number(inboxId));

  const { data, error } = await query;
  if (error) throw new Error(`Supabase: ${error.message}`);
  return data || [];
}

async function fetchSnapshotsByDate(conversationIds, dates) {
  if (!supabase || !conversationIds.length) return [];
  const { data, error } = await supabase
    .from(SUPABASE_SNAPSHOTS_TABLE)
    .select('*')
    .in('conversation_id', conversationIds)
    .in('snapshot_date', dates);

  if (error) throw new Error(`Supabase snapshots: ${error.message}`);
  return data || [];
}

async function storeSnapshots(rows) {
  if (!supabase || !rows.length) return { stored: false, count: 0 };
  const { error } = await supabase
    .from(SUPABASE_SNAPSHOTS_TABLE)
    .upsert(rows, { onConflict: 'conversation_id,snapshot_date' });
  if (error) throw new Error(`Supabase snapshots: ${error.message}`);
  return { stored: true, count: rows.length };
}

function computeFollowupDiff({ report, todaySnap, yesterdaySnap }) {
  const changes = [];
  if (!todaySnap) {
    return {
      followup_status: 'sin_sincronizar',
      followup_label: 'Sin sincronizar hoy',
      changes,
      human_outbound_today: false,
      cliente_sin_respuesta: false,
      vs_yesterday: 'sin_snapshot_hoy'
    };
  }

  const humanToday = Boolean(todaySnap.human_outbound_today);
  const clienteSinRespuesta = Boolean(todaySnap.metrics?.cliente_sin_respuesta);

  let followupStatus = 'sin_seguimiento_hoy';
  let followupLabel = 'Sin seguimiento humano hoy';

  if (humanToday) {
    followupStatus = 'seguimiento_ok_hoy';
    followupLabel = 'Seguimiento humano hoy';
  } else if (clienteSinRespuesta) {
    followupStatus = 'cliente_sin_respuesta';
    followupLabel = 'Cliente esperando respuesta';
  }

  let vsYesterday = 'sin_snapshot_ayer';
  if (yesterdaySnap) {
    if (todaySnap.message_count > yesterdaySnap.message_count) {
      vsYesterday = 'actividad_nueva';
      changes.push(`+${todaySnap.message_count - yesterdaySnap.message_count} mensajes vs ayer`);
    } else if (
      todaySnap.message_count === yesterdaySnap.message_count &&
      todaySnap.last_message_at === yesterdaySnap.last_message_at
    ) {
      vsYesterday = 'sin_cambios';
      changes.push('Sin cambios de actividad vs ayer');
    } else {
      vsYesterday = 'actualizado';
      changes.push('Conversación actualizada vs ayer');
    }

    if (todaySnap.human_outbound_today && !yesterdaySnap.human_outbound_today) {
      changes.push('Primer seguimiento humano del día');
    }
    if (!todaySnap.human_outbound_today && yesterdaySnap.human_outbound_today) {
      changes.push('Ayer hubo seguimiento humano; hoy aún no');
    }
  }

  if (humanToday && yesterdaySnap?.last_human_outbound_at && todaySnap.last_human_outbound_at) {
    const prev = new Date(yesterdaySnap.last_human_outbound_at).getTime();
    const curr = new Date(todaySnap.last_human_outbound_at).getTime();
    if (curr > prev) changes.push('Nuevo mensaje humano saliente');
  }

  return {
    followup_status: followupStatus,
    followup_label: followupLabel,
    changes,
    human_outbound_today: humanToday,
    cliente_sin_respuesta: clienteSinRespuesta,
    vs_yesterday: vsYesterday
  };
}

function buildFollowupItems(reports, snapshots, snapshotDate) {
  const yesterdayDate = addCalendarDays(snapshotDate, -1);
  const snapByKey = new Map();
  for (const snap of snapshots) {
    snapByKey.set(`${snap.conversation_id}:${snap.snapshot_date}`, snap);
  }

  return reports.map(report => {
    const convId = Number(report.conversation_id);
    const todaySnap = snapByKey.get(`${convId}:${snapshotDate}`) || null;
    const yesterdaySnap = snapByKey.get(`${convId}:${yesterdayDate}`) || null;
    const diff = computeFollowupDiff({ report, todaySnap, yesterdaySnap });

    return {
      conversation_id: convId,
      contact_id: report.contact_id,
      contact_name: report.contact_name,
      contact_phone: report.contact_phone,
      branch_name: report.branch_name,
      inbox_id: report.inbox_id,
      stage: report.stage,
      risk_level: report.risk_level,
      conversation_url: report.conversation_url,
      recommendation: report.recommendation,
      summary: report.summary,
      analyzed_at: report.analyzed_at,
      snapshot_date: snapshotDate,
      yesterday_snapshot_date: yesterdayDate,
      today_snapshot: todaySnap,
      yesterday_snapshot: yesterdaySnap,
      ...diff
    };
  });
}

function summarizeFollowupItems(items) {
  const summary = {
    total: items.length,
    seguimiento_ok_hoy: 0,
    sin_seguimiento_hoy: 0,
    cliente_sin_respuesta: 0,
    sin_sincronizar: 0,
    actividad_nueva: 0,
    sin_cambios: 0
  };

  for (const item of items) {
    if (item.followup_status === 'seguimiento_ok_hoy') summary.seguimiento_ok_hoy += 1;
    else if (item.followup_status === 'cliente_sin_respuesta') summary.cliente_sin_respuesta += 1;
    else if (item.followup_status === 'sin_sincronizar') summary.sin_sincronizar += 1;
    else summary.sin_seguimiento_hoy += 1;

    if (item.vs_yesterday === 'actividad_nueva') summary.actividad_nueva += 1;
    if (item.vs_yesterday === 'sin_cambios') summary.sin_cambios += 1;
  }

  return summary;
}

function parseStagesParam(value) {
  if (!value) return [...FOLLOWUP_STAGES];
  return value
    .split(',')
    .map(stage => stage.trim())
    .filter(Boolean);
}

async function syncFollowupSnapshots({ baseUrl, accountId, token, inboxId, branchName, stages, limit }) {
  const reports = await fetchReportsForFollowup({ inboxId, stages, limit });
  const snapshotDate = calendarDateInTimezone();
  const rows = [];
  const errors = [];

  for (const report of reports) {
    try {
      const messages = await fetchConversationMessages({
        baseUrl,
        accountId,
        conversationId: report.conversation_id,
        token
      });
      const metrics = extendMetricsWithFollowup(messages, snapshotDate);
      rows.push(rowForSnapshot({
        report,
        metrics,
        snapshotDate,
        baseUrl,
        accountId
      }));
    } catch (err) {
      errors.push({ conversation_id: report.conversation_id, error: err.message });
    }
  }

  const storeResult = rows.length ? await storeSnapshots(rows) : { stored: false, count: 0 };
  return {
    snapshot_date: snapshotDate,
    reports_matched: reports.length,
    synced: storeResult.count,
    stored: storeResult.stored,
    errors,
    stages
  };
}

function getBearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  if (!header.startsWith('Bearer ')) return '';
  return header.slice(7).trim();
}

async function verifySupabaseUser(req) {
  if (!AUTH_REQUIRED) return { ok: true, user: null };
  if (!AUTH_CLIENT_READY) {
    return {
      ok: false,
      status: 503,
      error: 'Falta SUPABASE_ANON_KEY en el servidor. Configura .env y reinicia.'
    };
  }
  const token = getBearerToken(req);
  if (!token) {
    return { ok: false, status: 401, error: 'Falta token de sesión. Inicia sesión.' };
  }
  if (!supabase) {
    return { ok: false, status: 503, error: 'Supabase no está configurado en el servidor.' };
  }
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return { ok: false, status: 401, error: 'Sesión inválida o expirada. Vuelve a iniciar sesión.' };
  }
  return { ok: true, user: data.user };
}

async function requireSupabaseAuth(req, res) {
  const result = await verifySupabaseUser(req);
  if (!result.ok) {
    sendJson(res, result.status, { error: result.error });
    return false;
  }
  return true;
}

async function handleAuthApi(req, res, pathname) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/api/auth/config' && req.method === 'GET') {
    sendJson(res, 200, {
      authRequired: AUTH_REQUIRED,
      authClientReady: AUTH_CLIENT_READY,
      supabaseUrl: AUTH_REQUIRED ? process.env.SUPABASE_URL || '' : '',
      supabaseAnonKey: AUTH_CLIENT_READY ? SUPABASE_ANON_KEY : '',
      setupError: AUTH_REQUIRED && !AUTH_CLIENT_READY
        ? 'Añade SUPABASE_ANON_KEY en .env (Supabase → Project Settings → API → anon public) y reinicia el servidor.'
        : null
    });
    return;
  }

  if (pathname === '/api/auth/session' && req.method === 'GET') {
    const result = await verifySupabaseUser(req);
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error, authenticated: false });
      return;
    }
    sendJson(res, 200, {
      authenticated: true,
      user: result.user
        ? { id: result.user.id, email: result.user.email }
        : null
    });
    return;
  }

  sendJson(res, 404, { error: 'Endpoint de auth no encontrado.' });
}

async function handleSupervisorApi(req, res, pathname) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!(await requireSupabaseAuth(req, res))) return;

  if (pathname === '/api/supervisor/health' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      openai_configured: Boolean(openai),
      supabase_configured: Boolean(supabase),
      chatwoot_token_configured: Boolean(process.env.CHATWOOT_API_TOKEN),
      model: OPENAI_MODEL,
      reports_table: SUPABASE_REPORTS_TABLE,
      snapshots_table: SUPABASE_SNAPSHOTS_TABLE,
      followup_timezone: FOLLOWUP_TIMEZONE,
      followup_stages: FOLLOWUP_STAGES,
      quote_url_regions: QUOTE_URL_REGIONS,
      max_ai_messages: MAX_AI_MESSAGES,
      max_transcript_chars: MAX_TRANSCRIPT_CHARS,
      max_conversation_messages: MAX_CONVERSATION_MESSAGES,
      chatwoot_messages_page_size: CHATWOOT_MESSAGES_PAGE_SIZE,
      ai_agent_sender_name: AI_AGENT_SENDER_NAME,
      architect_sender_names: ARCHITECT_SENDER_NAMES,
      inactive_days_threshold: INACTIVE_DAYS_THRESHOLD,
      inactivity_tag: INACTIVITY_TAG,
      supervisor_max_conversations: SUPERVISOR_MAX_CONVERSATIONS,
      supervisor_max_conversation_pages: SUPERVISOR_MAX_CONVERSATION_PAGES,
      chatwoot_activity_window_hours: CHATWOOT_ACTIVITY_WINDOW_HOURS,
      fetch_strategy: 'conversaciones_con_actividad_reciente_mas_bd',
      auth_required: AUTH_REQUIRED,
      auth_client_ready: AUTH_CLIENT_READY,
      logging: {
        level: process.env.SUPERVISOR_LOG_LEVEL || 'info',
        to_file: process.env.SUPERVISOR_LOG_TO_FILE === 'true',
        llm_warn_chars: parseInt(process.env.SUPERVISOR_LLM_WARN_CHARS || '80000', 10)
      }
    });
    return;
  }

  if (pathname === '/api/supervisor/reports' && req.method === 'GET') {
    if (!supabase) {
      sendJson(res, 503, { error: 'Supabase no está configurado.' });
      return;
    }

    const url = new URL(req.url, 'http://internal');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    let query = supabase
      .from(SUPABASE_REPORTS_TABLE)
      .select('*')
      .order('analyzed_at', { ascending: false })
      .limit(limit);

    for (const [param, column] of [
      ['branch', 'branch_name'],
      ['inbox_id', 'inbox_id'],
      ['stage', 'stage'],
      ['risk_level', 'risk_level']
    ]) {
      const value = url.searchParams.get(param);
      if (value) query = query.eq(column, value);
    }

    const { data, error } = await query;
    if (error) throw new Error(`Supabase: ${error.message}`);
    sendJson(res, 200, { reports: data || [] });
    return;
  }

  if (pathname === '/api/supervisor/logs' && req.method === 'GET') {
    const url = new URL(req.url, 'http://internal');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 100);
    sendJson(res, 200, { runs: listRuns(limit) });
    return;
  }

  const logsRunMatch = pathname.match(/^\/api\/supervisor\/logs\/([^/]+)$/);
  if (logsRunMatch && req.method === 'GET') {
    const run = getRun(logsRunMatch[1]);
    if (!run) {
      sendJson(res, 404, { error: 'Run de log no encontrado.' });
      return;
    }
    sendJson(res, 200, {
      run_id: run.run_id,
      started_at: run.started_at,
      finished_at: run.finished_at,
      duration_ms: run.duration_ms,
      status: run.status,
      meta: run.meta,
      current_step: run.current_step,
      summary: run.summary,
      events: run.events
    });
    return;
  }

  if (pathname === '/api/supervisor/analyze' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const baseUrl = cleanBaseUrl(body.baseUrl);
    const accountId = String(body.accountId || process.env.CHATWOOT_ACCOUNT_ID || '').trim();
    const inboxId = body.inboxId || body.inbox_id || '';
    const branchName = body.branchName || body.branch || '';
    const windowHours = Math.max(
      1,
      parseInt(body.activityWindowHours || body.activity_window_hours || CHATWOOT_ACTIVITY_WINDOW_HOURS, 10)
    );
    const token = chatwootTokenFrom(req, body);
    const includeFullDebug = body.debug !== false;

    const log = createSupervisorRunLogger({
      inbox_id: inboxId,
      branch_name: branchName,
      account_id: accountId,
      window_hours: windowHours
    });

    try {
      if (!accountId) throw new Error('Falta accountId o CHATWOOT_ACCOUNT_ID.');
      if (!token) throw new Error('Falta token de Chatwoot: usa CHATWOOT_API_TOKEN en .env o envíalo en la petición.');
      if (!openai) throw new Error('Falta OPENAI_API_KEY en .env.');

      log.stepStart('chatwoot_list_conversations', { inbox_id: inboxId, window_hours: windowHours });
      const activityFetch = await fetchConversationsWithRecentActivity({
        baseUrl,
        accountId,
        inboxId,
        token,
        windowHours,
        logger: log
      });
      const conversations = activityFetch.conversations;
      const sinceUnix = activityFetch.sinceUnix;
      log.stepEnd('chatwoot_list_conversations', {
        conversations_with_activity: conversations.length,
        pages_scanned: activityFetch.pages_scanned,
        since_unix: sinceUnix
      });

      const rows = [];
      const snapshotRows = [];
      const errors = [];
      const snapshotDate = calendarDateInTimezone();
      const total = conversations.length;

      log.setSummary({ conversations_total: total });

      for (let index = 0; index < conversations.length; index++) {
        const conversation = conversations[index];
        const convLabel = `conv_${conversation.id}`;
        log.info('conversation_loop', {
          index: index + 1,
          total,
          conversation_id: conversation.id,
          contact: conversation.meta?.sender?.name || null
        });

        try {
          log.stepStart(`${convLabel}_supabase_previous_report`);
          const previousReport = await fetchPreviousReport(conversation.id);
          const storedHistorical = buildStoredHistoricalContext(previousReport);
          log.stepEnd(`${convLabel}_supabase_previous_report`, {
            has_previous: Boolean(previousReport),
            narrative_chars: storedHistorical?.narrative_for_ai?.length || 0
          });

          log.stepStart(`${convLabel}_chatwoot_recent_messages`);
          const recentMessages = await fetchRecentConversationMessages({
            baseUrl,
            accountId,
            conversationId: conversation.id,
            token,
            sinceUnix,
            logger: log
          });
          log.stepEnd(`${convLabel}_chatwoot_recent_messages`, {
            messages_count: recentMessages.length,
            sample_ids: recentMessages.slice(0, 3).map(m => m.id)
          });

          if (
            !recentMessages.length &&
            !storedHistorical &&
            !conversationHasRecentActivity(conversation, sinceUnix)
          ) {
            log.warn(`${convLabel}_skipped`, { reason: 'sin_mensajes_ni_historico_ni_actividad' });
            continue;
          }

          const metricsMerged = mergeMetricsForAnalysis(
            previousReport?.metrics,
            recentMessages,
            windowHours
          );
          const metrics = extendMetricsWithFollowup(recentMessages, snapshotDate, metricsMerged);
          const actualInboxId = conversation.inbox_id || inboxId;
          const quoteRecent = detectQuoteInMessages(recentMessages, actualInboxId, branchName);
          const quoteDetection = mergeQuoteDetectionWithStored(quoteRecent, storedHistorical);
          metrics.quote_detection = quoteDetection;
          const inactivityTagging = buildInactivityTagging(
            recentMessages,
            metricsMerged,
            quoteDetection,
            storedHistorical
          );
          metrics.inactivity_tagging = inactivityTagging;
          metrics.days_since_last_interaction = inactivityTagging.days_since_last_interaction;
          metrics.supervisor_tags = inactivityTagging.supervisor_tags;

          const snapshotHistory = await fetchSnapshotHistory(conversation.id, 14);
          const enrichment = buildAnalysisEnrichment({
            recentMessages,
            metrics,
            previousReport,
            snapshotHistory,
            quoteDetection,
            inactivityTagging,
            storedHistorical,
            activityWindowHours: windowHours
          });
          metrics.new_messages_at_analysis =
            enrichment.activity_delta.new_messages_since_last_analysis;

          const transcriptRecentChars =
            enrichment.transcripts?.ultimas_horas_chatwoot?.transcript?.length || 0;
          const transcriptDbChars =
            enrichment.transcripts?.historico_resumido_bd?.transcript?.length || 0;
          log.info(`${convLabel}_enrichment_ready`, {
            transcript_recent_chars: transcriptRecentChars,
            transcript_db_chars: transcriptDbChars,
            analysis_mode: enrichment.analysis_mode,
            new_messages_since_last: enrichment.activity_delta.new_messages_since_last_analysis
          });

          const contact = conversation.meta?.sender || conversation.contact || {};
          let analysis = await analyzeWithOpenAI({
            conversation,
            contact,
            messages: recentMessages,
            metrics,
            enrichment,
            baseUrl,
            accountId,
            branchName,
            inboxId,
            logger: log
          });
          analysis = mergeQuoteDetectionIntoAnalysis(analysis, quoteDetection);
          analysis = mergeInactivityTagging(analysis, inactivityTagging);

          const reportRow = rowForReport({
            conversation,
            contact,
            messages: recentMessages,
            metrics: {
              ...metricsMerged,
              ...metrics,
              quote_detection: quoteDetection,
              inactivity_tagging: inactivityTagging,
              days_since_last_interaction: inactivityTagging.days_since_last_interaction,
              supervisor_tags: uniqueNonEmpty([
                ...(inactivityTagging.supervisor_tags || []),
                ...(analysis.supervisor_tags || [])
              ])
            },
            analysis,
            baseUrl,
            accountId,
            branchName,
            inboxId
          });
          rows.push(reportRow);
          snapshotRows.push(rowForSnapshot({
            report: reportRow,
            metrics,
            snapshotDate,
            baseUrl,
            accountId
          }));
          log.info(`${convLabel}_analyzed_ok`, { stage: reportRow.stage, risk: reportRow.risk_level });
        } catch (err) {
          log.error(`${convLabel}_failed`, { error: err.message });
          errors.push({ conversation_id: conversation.id, error: err.message });
        }
      }

      log.stepStart('supabase_store_reports');
      const storeResult = rows.length ? await storeReports(rows) : { stored: false, count: 0 };
      log.stepEnd('supabase_store_reports', storeResult);

      log.stepStart('supabase_store_snapshots');
      const snapshotResult = snapshotRows.length && supabase
        ? await storeSnapshots(snapshotRows)
        : { stored: false, count: 0 };
      log.stepEnd('supabase_store_snapshots', snapshotResult);

      const taggedInactive = rows.filter(row =>
        LEGACY_INACTIVITY_TAGS.some(tag => (row.metrics?.supervisor_tags || []).includes(tag))
      ).length;

      log.finish('completed', {
        analyzed: rows.length,
        fetched: conversations.length,
        errors_count: errors.length,
        tagged_inactive_interest: taggedInactive
      });

      const debugPayload = log.toJSON();
      sendJson(res, 200, {
        run_id: log.runId,
        analyzed: rows.length,
        fetched: conversations.length,
        activity_window_hours: windowHours,
        pages_scanned: activityFetch.pages_scanned,
        fetch_strategy: 'actividad_reciente_chatwoot_mas_historico_supabase',
        tagged_inactive_interest: taggedInactive,
        inactive_days_threshold: INACTIVE_DAYS_THRESHOLD,
        stored: storeResult.stored,
        store_count: storeResult.count,
        snapshots_stored: snapshotResult.stored,
        snapshot_count: snapshotResult.count,
        snapshot_date: snapshotDate,
        errors,
        reports: rows,
        debug: includeFullDebug
          ? debugPayload
          : {
            run_id: debugPayload.run_id,
            status: debugPayload.status,
            duration_ms: debugPayload.duration_ms,
            summary: debugPayload.summary,
            current_step: debugPayload.current_step,
            last_events: debugPayload.events.slice(-15)
          }
      });
    } catch (err) {
      log.error('analyze_run_failed', { error: err.message });
      log.finish('failed', { error: err.message });
      throw err;
    }
    return;
  }

  if (pathname === '/api/supervisor/followup/sync' && req.method === 'POST') {
    if (!supabase) {
      sendJson(res, 503, { error: 'Supabase no está configurado.' });
      return;
    }

    const body = await readJsonBody(req);
    const baseUrl = cleanBaseUrl(body.baseUrl);
    const accountId = String(body.accountId || process.env.CHATWOOT_ACCOUNT_ID || '').trim();
    const inboxId = body.inboxId || body.inbox_id || '';
    const token = chatwootTokenFrom(req, body);
    const stages = parseStagesParam(body.stages);
    const limit = Math.min(parseInt(body.limit || '100', 10), 200);

    if (!accountId) throw new Error('Falta accountId o CHATWOOT_ACCOUNT_ID.');
    if (!token) throw new Error('Falta token de Chatwoot.');

    const result = await syncFollowupSnapshots({
      baseUrl,
      accountId,
      token,
      inboxId,
      stages,
      limit
    });

    sendJson(res, 200, result);
    return;
  }

  if (pathname === '/api/supervisor/followup' && req.method === 'GET') {
    if (!supabase) {
      sendJson(res, 503, { error: 'Supabase no está configurado.' });
      return;
    }

    const url = new URL(req.url, 'http://internal');
    const inboxId = url.searchParams.get('inbox_id') || '';
    const stages = parseStagesParam(url.searchParams.get('stages'));
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 200);
    const snapshotDate = url.searchParams.get('snapshot_date') ||
      calendarDateInTimezone();

    const reports = await fetchReportsForFollowup({ inboxId, stages, limit });
    const conversationIds = reports.map(report => Number(report.conversation_id));
    const yesterdayDate = addCalendarDays(snapshotDate, -1);
    const snapshots = await fetchSnapshotsByDate(conversationIds, [snapshotDate, yesterdayDate]);
    const items = buildFollowupItems(reports, snapshots, snapshotDate);
    const summary = summarizeFollowupItems(items);

    sendJson(res, 200, {
      snapshot_date: snapshotDate,
      yesterday_date: yesterdayDate,
      timezone: FOLLOWUP_TIMEZONE,
      stages,
      summary,
      items
    });
    return;
  }

  sendJson(res, 404, { error: 'Endpoint supervisor no encontrado.' });
}

function serveStatic(req, res, relativeFile) {
  const filePath = path.join(STATIC_ROOT, relativeFile);
  if (!filePath.startsWith(STATIC_ROOT)) {
    res.writeHead(403);
    res.end();
    return;
  }

  const ext = path.extname(relativeFile);
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  stream.pipe(res);
}

const server = http.createServer((req, res) => {
  const pathname = pathnameOnly(req.url);

  if (pathname.startsWith('/api/auth/')) {
    handleAuthApi(req, res, pathname).catch(err => {
      sendJson(res, 500, { error: err.message });
    });
    return;
  }

  if (pathname.startsWith('/api/supervisor/')) {
    handleSupervisorApi(req, res, pathname).catch(err => {
      sendJson(res, 500, { error: err.message });
    });
    return;
  }

  if (pathname.startsWith('/chatwoot/')) {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (AUTH_REQUIRED) {
      verifySupabaseUser(req).then(result => {
        if (!result.ok) {
          sendJson(res, result.status, { error: result.error });
          return;
        }
        proxyChatwootRequest(req, res);
      });
      return;
    }

    proxyChatwootRequest(req, res);
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  const file = STATIC_ROUTES[pathname];
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  serveStatic(req, res, file);
});

function proxyChatwootRequest(req, res) {
    const targetBaseUrl = getTargetBaseUrl(req);
    const upstreamPath = req.url.replace(/^\/chatwoot/, '');

    let upstreamUrl;
    try {
      upstreamUrl = new URL(`${targetBaseUrl}${upstreamPath}`);
    } catch (err) {
      sendJson(res, 400, { error: 'URL de Chatwoot inválida.' });
      return;
    }

    const httpLib = upstreamUrl.protocol === 'https:' ? https : http;
    const upstreamHeaders = headersForUpstream(req);

    const proxyReq = httpLib.request(
      upstreamUrl,
      { method: req.method, headers: upstreamHeaders },
      (proxyRes) => {
        const responseHeaders = { ...proxyRes.headers };
        delete responseHeaders['access-control-allow-origin'];
        delete responseHeaders['access-control-allow-methods'];
        delete responseHeaders['access-control-allow-headers'];

        setCorsHeaders(res);
        res.writeHead(proxyRes.statusCode || 500, responseHeaders);
        proxyRes.pipe(res);
      }
    );

    proxyReq.on('error', (err) => {
      sendJson(res, 502, { error: 'Error al conectar con Chatwoot', detail: err.message });
    });

    req.pipe(proxyReq);
}

server.listen(PORT, HOST, () => {
  console.log(`Chatwoot dashboard + proxy en http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
  console.log(`  UI:    http://127.0.0.1:${PORT}/`);
  console.log(`  Login: http://127.0.0.1:${PORT}/login.html`);
  console.log(`  API:   http://127.0.0.1:${PORT}/chatwoot/api/v1/...`);
  if (AUTH_REQUIRED && !AUTH_CLIENT_READY) {
    console.warn('  Auth:  ACTIVA pero falta SUPABASE_ANON_KEY — el login no funcionará hasta configurarla.');
  } else {
    console.log(`  Auth:  ${AUTH_REQUIRED ? 'requerida (Supabase JWT)' : 'desactivada (AUTH_REQUIRED=false)'}`);
  }
});
