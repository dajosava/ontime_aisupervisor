require('dotenv').config();

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
  return headerValue.replace(/\/$/, '');
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
      supabaseUrl: AUTH_REQUIRED ? supabaseUrl : '',
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
      openai_configured: openaiConfigured(),
      supabase_configured: supabaseConfigured(),
      chatwoot_token_configured: Boolean(process.env.CHATWOOT_API_TOKEN),
      model: getSupervisorConfig().OPENAI_MODEL,
      reports_table: getSupervisorConfig().SUPABASE_REPORTS_TABLE,
      snapshots_table: getSupervisorConfig().SUPABASE_SNAPSHOTS_TABLE,
      followup_timezone: getSupervisorConfig().FOLLOWUP_TIMEZONE,
      followup_stages: getSupervisorConfig().FOLLOWUP_STAGES,
      quote_url_regions: getSupervisorConfig().QUOTE_URL_REGIONS,
      max_ai_messages: getSupervisorConfig().MAX_AI_MESSAGES,
      max_transcript_chars: getSupervisorConfig().MAX_TRANSCRIPT_CHARS,
      max_conversation_messages: getSupervisorConfig().MAX_CONVERSATION_MESSAGES,
      chatwoot_messages_page_size: getSupervisorConfig().CHATWOOT_MESSAGES_PAGE_SIZE,
      ai_agent_sender_name: getSupervisorConfig().AI_AGENT_SENDER_NAME,
      architect_sender_names: getSupervisorConfig().ARCHITECT_SENDER_NAMES,
      inactive_days_threshold: INACTIVE_DAYS_THRESHOLD,
      inactivity_tag: INACTIVITY_TAG,
      supervisor_max_conversations: getSupervisorConfig().SUPERVISOR_MAX_CONVERSATIONS,
      supervisor_max_conversation_pages: getSupervisorConfig().SUPERVISOR_MAX_CONVERSATION_PAGES,
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
      if (!openaiConfigured()) throw new Error('Falta OPENAI_API_KEY en .env.');

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
      const snapshotResult = snapshotRows.length && supabaseConfigured()
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
    if (!supabaseConfigured()) {
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
    if (!supabaseConfigured()) {
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
      timezone: getSupervisorConfig().FOLLOWUP_TIMEZONE,
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
