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
  fetchConversationById,
  activityWindowSinceUnix,
  CHATWOOT_ACTIVITY_WINDOW_HOURS
} = require('./services/chatwoot.service');
const {
  getExcludedChatwootLabels,
  partitionConversationsByExcludedLabels
} = require('./services/chatwoot-labels.service');
const {
  isConfigured: supabaseConfigured,
  getAuthConfig,
  verifySupabaseUser,
  storeReports,
  storeSnapshots,
  listReports,
  fetchReportsForFollowup,
  fetchSnapshotsByDate
} = require('./services/supabase.service');
const { isConfigured: openaiConfigured } = require('./services/openai.service');
const { processConversationForAnalysis } = require('./agent/process-conversation');
const {
  isAgentAnalyzeMode,
  isLegacyAnalyzeMode,
  getMaxAgentRounds
} = require('./agent/analyze-config');
const { getPlaybookVersion } = require('./supervisor/playbook');
const {
  getSettingsForApi,
  saveSettings,
  resetSettings,
  listSettingsBackups,
  restoreSettingsBackup
} = require('./supervisor/settings.service');
const {
  getSupervisorConfig,
  INACTIVITY_TAG,
  LEGACY_INACTIVITY_TAGS,
  calendarDateInTimezone,
  addCalendarDays,
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
      inactive_days_threshold: getSupervisorConfig().INACTIVE_DAYS_THRESHOLD,
      inactivity_tag: INACTIVITY_TAG,
      supervisor_max_conversations: getSupervisorConfig().SUPERVISOR_MAX_CONVERSATIONS,
      supervisor_max_conversation_pages: getSupervisorConfig().SUPERVISOR_MAX_CONVERSATION_PAGES,
      chatwoot_activity_window_hours: getSupervisorConfig().CHATWOOT_ACTIVITY_WINDOW_HOURS,
      excluded_chatwoot_labels: getExcludedChatwootLabels(),
      openai_temperature: getSupervisorConfig().OPENAI_TEMPERATURE,
      agent_max_tools_per_round: getSupervisorConfig().AGENT_MAX_TOOLS_PER_ROUND,
      settings_source: getSettingsForApi().source,
      fetch_strategy: 'conversaciones_con_actividad_reciente_mas_bd',
      auth_required: AUTH_REQUIRED,
      auth_client_ready: AUTH_CLIENT_READY,
      logging: {
        level: process.env.SUPERVISOR_LOG_LEVEL || 'info',
        to_file: process.env.SUPERVISOR_LOG_TO_FILE === 'true',
        llm_warn_chars: parseInt(process.env.SUPERVISOR_LLM_WARN_CHARS || '80000', 10)
      },
      supervisor_agent_mode: isAgentAnalyzeMode(),
      supervisor_legacy_mode: isLegacyAnalyzeMode(),
      playbook_version: getPlaybookVersion(),
      agent_max_rounds: getMaxAgentRounds()
    });
    return;
  }

  if (pathname === '/api/supervisor/settings' && req.method === 'GET') {
    sendJson(res, 200, { settings: getSettingsForApi() });
    return;
  }

  if (pathname === '/api/supervisor/settings' && req.method === 'PUT') {
    const body = await readJsonBody(req);
    const auth = await verifySupabaseUser(req);
    try {
      const saved = saveSettings(body, { email: auth.user?.email || 'ui' });
      sendJson(res, 200, {
        ok: true,
        settings: getSettingsForApi({ last_backup: saved.last_backup }),
        backup: saved.last_backup
      });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  if (pathname === '/api/supervisor/settings/backups' && req.method === 'GET') {
    const url = new URL(req.url, 'http://internal');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '25', 10), 50);
    sendJson(res, 200, { backups: listSettingsBackups(limit) });
    return;
  }

  if (pathname === '/api/supervisor/settings/restore' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const auth = await verifySupabaseUser(req);
    try {
      const result = restoreSettingsBackup(body.backup_id || body.backupId, {
        email: auth.user?.email || 'ui'
      });
      sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  if (pathname === '/api/supervisor/settings/reset' && req.method === 'POST') {
    const auth = await verifySupabaseUser(req);
    try {
      resetSettings({ email: auth.user?.email || 'reset' });
      sendJson(res, 200, { ok: true, settings: getSettingsForApi() });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
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

  if (pathname === '/api/supervisor/analyze/conversation' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const baseUrl = cleanBaseUrl(body.baseUrl);
    const accountId = String(body.accountId || process.env.CHATWOOT_ACCOUNT_ID || '').trim();
    const conversationId = parseInt(
      body.conversationId || body.conversation_id || '',
      10
    );
    const inboxId = body.inboxId || body.inbox_id || '';
    const branchName = body.branchName || body.branch || '';
    const fullHistory = body.fullHistory !== false && body.full_history !== false;
    const forceAnalyze = body.forceAnalyze !== false && body.force_analyze !== false;
    const token = chatwootTokenFrom(req, body);

    const log = createSupervisorRunLogger({
      inbox_id: inboxId,
      branch_name: branchName,
      account_id: accountId,
      conversation_id: conversationId,
      full_history: fullHistory
    });

    try {
      if (!accountId) throw new Error('Falta accountId o CHATWOOT_ACCOUNT_ID.');
      if (!Number.isFinite(conversationId) || conversationId <= 0) {
        throw new Error('Falta conversationId válido.');
      }
      if (!token) {
        throw new Error('Falta token de Chatwoot: usa CHATWOOT_API_TOKEN en .env o envíalo en la petición.');
      }
      if (!openaiConfigured()) throw new Error('Falta OPENAI_API_KEY en .env.');

      log.stepStart('chatwoot_fetch_conversation', { conversation_id: conversationId });
      let conversation = await fetchConversationById({
        baseUrl,
        accountId,
        conversationId,
        token,
        logger: log
      });

      if (!conversation || !conversation.id) {
        conversation = {
          id: conversationId,
          inbox_id: inboxId || null,
          status: body.status || 'open',
          meta: {
            sender: {
              name: body.contactName || body.contact_name || '',
              phone_number: body.contactPhone || body.contact_phone || ''
            }
          }
        };
        log.warn('chatwoot_conversation_fallback', {
          conversation_id: conversationId,
          reason: 'respuesta_vacia_usando_datos_peticion'
        });
      }

      const resolvedInboxId = conversation.inbox_id || inboxId;
      const windowHours = getSupervisorConfig().CHATWOOT_ACTIVITY_WINDOW_HOURS;
      const sinceUnix = fullHistory ? 0 : activityWindowSinceUnix(windowHours);
      const snapshotDate = calendarDateInTimezone();
      const convLabel = `conv_${conversationId}`;

      log.stepEnd('chatwoot_fetch_conversation', {
        conversation_id: conversation.id,
        inbox_id: resolvedInboxId
      });

      const result = await processConversationForAnalysis({
        conversation,
        baseUrl,
        accountId,
        branchName,
        inboxId: resolvedInboxId,
        token,
        sinceUnix,
        windowHours,
        snapshotDate,
        logger: log,
        convLabel,
        fullHistory,
        forceAnalyze
      });

      if (result.skipped) {
        const reason = result.skip_reason || 'conversacion_omitida';
        log.finish('skipped', { reason, matched_labels: result.matched_labels || null });
        sendJson(res, 409, {
          error: reason === 'excluded_chatwoot_label'
            ? `Conversación con etiqueta excluida: ${(result.matched_labels || []).join(', ')}`
            : 'No se pudo analizar esta conversación.',
          skip_reason: reason,
          matched_labels: result.matched_labels || null
        });
        return;
      }

      log.stepStart('supabase_store_reports');
      const storeResult = await storeReports([result.reportRow]);
      log.stepEnd('supabase_store_reports', storeResult);

      log.stepStart('supabase_store_snapshots');
      const snapshotResult =
        supabaseConfigured() && result.snapshotRow
          ? await storeSnapshots([result.snapshotRow])
          : { stored: false, count: 0 };
      log.stepEnd('supabase_store_snapshots', snapshotResult);

      log.finish('completed', {
        conversation_id: conversationId,
        messages_fetched: result.messages_fetched,
        full_history: fullHistory,
        stage: result.reportRow.stage
      });

      sendJson(res, 200, {
        ok: true,
        run_id: log.runId,
        conversation_id: conversationId,
        full_history: fullHistory,
        messages_fetched: result.messages_fetched,
        analysis_mode: result.analysis_mode,
        playbook_version: getPlaybookVersion(),
        stored: storeResult.stored,
        snapshot_stored: snapshotResult.stored,
        report: result.reportRow,
        debug: log.toJSON()
      });
    } catch (err) {
      log.error('analyze_conversation_failed', { error: err.message });
      log.finish('failed', { error: err.message });
      throw err;
    }
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
      parseInt(
        body.activityWindowHours ||
          body.activity_window_hours ||
          getSupervisorConfig().CHATWOOT_ACTIVITY_WINDOW_HOURS,
        10
      )
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
      const conversationsFetched = activityFetch.conversations;
      const sinceUnix = activityFetch.sinceUnix;
      log.stepEnd('chatwoot_list_conversations', {
        conversations_with_activity: conversationsFetched.length,
        pages_scanned: activityFetch.pages_scanned,
        since_unix: sinceUnix
      });

      const labelPartition = partitionConversationsByExcludedLabels(conversationsFetched);
      const conversations = labelPartition.eligible;
      const skippedByLabel = labelPartition.skipped;

      log.stepEnd('chatwoot_filter_excluded_labels', {
        fetched: conversationsFetched.length,
        eligible: conversations.length,
        skipped: skippedByLabel.length,
        excluded_label_catalog: getExcludedChatwootLabels().length
      });

      const rows = [];
      const snapshotRows = [];
      const errors = [];
      const snapshotDate = calendarDateInTimezone();
      const total = conversations.length;

      log.setSummary({
        conversations_fetched: conversationsFetched.length,
        conversations_total: total,
        skipped_excluded_labels: skippedByLabel.length
      });

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
          const result = await processConversationForAnalysis({
            conversation,
            baseUrl,
            accountId,
            branchName,
            inboxId,
            token,
            sinceUnix,
            windowHours,
            snapshotDate,
            logger: log,
            convLabel
          });

          if (result.skipped) continue;

          rows.push(result.reportRow);
          snapshotRows.push(result.snapshotRow);
          log.info(`${convLabel}_analyzed_ok`, {
            stage: result.reportRow.stage,
            risk: result.reportRow.risk_level,
            analysis_mode: result.analysis_mode,
            agent_rounds: result.agent_meta?.rounds ?? null,
            fallback_used: result.agent_meta?.fallback_used ?? false
          });
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
        fetched: conversationsFetched.length,
        eligible_after_label_filter: conversations.length,
        skipped_excluded_labels: skippedByLabel.length,
        errors_count: errors.length,
        tagged_inactive_interest: taggedInactive
      });

      const debugPayload = log.toJSON();
      sendJson(res, 200, {
        run_id: log.runId,
        analyzed: rows.length,
        fetched: conversationsFetched.length,
        eligible_after_label_filter: conversations.length,
        skipped_excluded_labels: skippedByLabel.length,
        skipped_conversations: skippedByLabel.slice(0, 100),
        activity_window_hours: windowHours,
        pages_scanned: activityFetch.pages_scanned,
        fetch_strategy: isLegacyAnalyzeMode()
          ? 'legacy_single_prompt'
          : `agente_herramientas_playbook_${getPlaybookVersion()}`,
        supervisor_agent_mode: isAgentAnalyzeMode(),
        supervisor_legacy_mode: isLegacyAnalyzeMode(),
        playbook_version: getPlaybookVersion(),
        agent_max_rounds: getMaxAgentRounds(),
        tagged_inactive_interest: taggedInactive,
        inactive_days_threshold: getSupervisorConfig().INACTIVE_DAYS_THRESHOLD,
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
