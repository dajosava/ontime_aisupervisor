const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'proxy-server.js'), 'utf8');
const handlerStart = src.indexOf('function getBearerToken(req)');
const handlers = src.slice(handlerStart);
// Remove old implementations - keep from requireSupabaseAuth if exists, else from getBearerToken
const authStart = handlers.indexOf('async function requireSupabaseAuth');
const tail = authStart >= 0 ? handlers.slice(authStart) : handlers;

const header = `require('dotenv').config();

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const { createSupervisorRunLogger, getRun, listRuns } = require('./utils/logger');
const {
  DEFAULT_BASE_URL,
  cleanBaseUrl,
  chatwootTokenFrom,
  fetchConversationsWithRecentActivity,
  fetchRecentConversationMessages,
  conversationHasRecentActivity,
  CHATWOOT_ACTIVITY_WINDOW_HOURS
} = require('./services/chatwoot.service');
const {
  isConfigured: supabaseConfigured,
  getAuthConfig,
  verifySupabaseUser,
  storeReports,
  storeSnapshots,
  listReports,
  fetchPreviousReport,
  fetchSnapshotHistory,
  fetchReportsForFollowup,
  fetchSnapshotsByDate
} = require('./services/supabase.service');
const { isConfigured: openaiConfigured, analyzeWithOpenAI } = require('./services/openai.service');
const {
  getSupervisorConfig,
  INACTIVITY_TAG,
  LEGACY_INACTIVITY_TAGS,
  INACTIVE_DAYS_THRESHOLD,
  uniqueNonEmpty,
  buildStoredHistoricalContext,
  mergeMetricsForAnalysis,
  mergeQuoteDetectionWithStored,
  buildAnalysisEnrichment,
  mergeQuoteDetectionIntoAnalysis,
  mergeInactivityTagging,
  detectQuoteInMessages,
  buildInactivityTagging,
  rowForReport,
  rowForSnapshot,
  calendarDateInTimezone,
  addCalendarDays,
  extendMetricsWithFollowup,
  buildFollowupItems,
  summarizeFollowupItems,
  parseStagesParam,
  syncFollowupSnapshots
} = require('./services/supervisor.service');

const { AUTH_REQUIRED, AUTH_CLIENT_READY, SUPABASE_ANON_KEY, supabaseUrl } = getAuthConfig();

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';

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
      } catch {
        reject(new Error('JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

function getTargetBaseUrl(req) {
  const headerValue = (req.headers['x-chatwoot-base-url'] || '').toString().trim();
  if (!headerValue) return DEFAULT_BASE_URL;
  return headerValue.replace(/\\/$/, '');
}

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

`;

// tail starts with requireSupabaseAuth - remove duplicate getBearerToken and verifySupabaseUser from tail
let cleanedTail = tail
  .replace(/function getBearerToken[\s\S]*?^}\s*$/m, '')
  .replace(/async function verifySupabaseUser[\s\S]*?^}\s*$/m, '');

// Fix health endpoint references
cleanedTail = cleanedTail.replace(/Boolean\(openai\)/g, 'openaiConfigured()');
cleanedTail = cleanedTail.replace(/Boolean\(supabase\)/g, 'supabaseConfigured()');
cleanedTail = cleanedTail.replace(/if \(!openai\)/g, 'if (!openaiConfigured())');
cleanedTail = cleanedTail.replace(/if \(!supabase\)/g, 'if (!supabaseConfigured())');
cleanedTail = cleanedTail.replace(/OPENAI_MODEL/g, 'getSupervisorConfig().OPENAI_MODEL');
cleanedTail = cleanedTail.replace(/SUPABASE_REPORTS_TABLE/g, 'getSupervisorConfig().SUPABASE_REPORTS_TABLE');
cleanedTail = cleanedTail.replace(/SUPABASE_SNAPSHOTS_TABLE/g, 'getSupervisorConfig().SUPABASE_SNAPSHOTS_TABLE');
cleanedTail = cleanedTail.replace(/FOLLOWUP_TIMEZONE/g, 'getSupervisorConfig().FOLLOWUP_TIMEZONE');
cleanedTail = cleanedTail.replace(/FOLLOWUP_STAGES/g, 'getSupervisorConfig().FOLLOWUP_STAGES');
cleanedTail = cleanedTail.replace(/QUOTE_URL_REGIONS/g, 'getSupervisorConfig().QUOTE_URL_REGIONS');
cleanedTail = cleanedTail.replace(/MAX_AI_MESSAGES/g, 'getSupervisorConfig().MAX_AI_MESSAGES');
cleanedTail = cleanedTail.replace(/MAX_TRANSCRIPT_CHARS/g, 'getSupervisorConfig().MAX_TRANSCRIPT_CHARS');
cleanedTail = cleanedTail.replace(/MAX_CONVERSATION_MESSAGES/g, 'getSupervisorConfig().MAX_CONVERSATION_MESSAGES');
cleanedTail = cleanedTail.replace(/CHATWOOT_MESSAGES_PAGE_SIZE/g, 'getSupervisorConfig().CHATWOOT_MESSAGES_PAGE_SIZE');
cleanedTail = cleanedTail.replace(/AI_AGENT_SENDER_NAME/g, 'getSupervisorConfig().AI_AGENT_SENDER_NAME');
cleanedTail = cleanedTail.replace(/ARCHITECT_SENDER_NAMES/g, 'getSupervisorConfig().ARCHITECT_SENDER_NAMES');
cleanedTail = cleanedTail.replace(/SUPERVISOR_MAX_CONVERSATIONS/g, 'getSupervisorConfig().SUPERVISOR_MAX_CONVERSATIONS');
cleanedTail = cleanedTail.replace(/SUPERVISOR_MAX_CONVERSATION_PAGES/g, 'getSupervisorConfig().SUPERVISOR_MAX_CONVERSATION_PAGES');

// Auth config endpoint
cleanedTail = cleanedTail.replace(
  /supabaseUrl: AUTH_REQUIRED \? process\.env\.SUPABASE_URL \|\| '' : ''/,
  'supabaseUrl: AUTH_REQUIRED ? supabaseUrl : \'\''
);
cleanedTail = cleanedTail.replace(
  /supabaseAnonKey: AUTH_CLIENT_READY \? SUPABASE_ANON_KEY : ''/,
  'supabaseAnonKey: AUTH_CLIENT_READY ? SUPABASE_ANON_KEY : \'\''
);

// reports list - use listReports
cleanedTail = cleanedTail.replace(
  /if \(pathname === '\/api\/supervisor\/reports'[\s\S]*?sendJson\(res, 200, \{ reports: data \|\| \[\] \}\);\s*return;\s*}/,
  `if (pathname === '/api/supervisor/reports' && req.method === 'GET') {
    if (!supabaseConfigured()) {
      sendJson(res, 503, { error: 'Supabase no está configurado.' });
      return;
    }

    const url = new URL(req.url, 'http://internal');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const filters = {};
    for (const [param, column] of [
      ['branch', 'branch_name'],
      ['inbox_id', 'inbox_id'],
      ['stage', 'stage'],
      ['risk_level', 'risk_level']
    ]) {
      const value = url.searchParams.get(param);
      if (value) filters[column] = value;
    }

    const data = await listReports({ limit, filters });
    sendJson(res, 200, { reports: data });
    return;
  }`
);

// snapshot store uses supabaseConfigured
cleanedTail = cleanedTail.replace(/snapshotRows\.length && supabase/g, 'snapshotRows.length && supabaseConfigured()');

const out = header + cleanedTail;
fs.writeFileSync(path.join(__dirname, '..', 'proxy-server.new.js'), out);
console.log('written proxy-server.new.js', out.length);
