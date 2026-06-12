const {
  cleanBaseUrl,
  fetchConversationsWithRecentActivity,
  DEFAULT_BASE_URL
} = require('./chatwoot.service');
const {
  getExcludedChatwootLabels,
  partitionConversationsByExcludedLabels
} = require('./chatwoot-labels.service');
const { storeReports, storeSnapshots, isConfigured: supabaseConfigured } = require('./supabase.service');
const { isConfigured: openaiConfigured } = require('./openai.service');
const { processConversationForAnalysis } = require('../agent/process-conversation');
const {
  isAgentAnalyzeMode,
  isLegacyAnalyzeMode,
  getMaxAgentRounds
} = require('../agent/analyze-config');
const { getPlaybookVersion } = require('../supervisor/playbook');
const {
  getSupervisorConfig,
  LEGACY_INACTIVITY_TAGS,
  calendarDateInTimezone
} = require('./supervisor.service');
const { createSupervisorRunLogger } = require('../utils/logger');

/**
 * Ejecuta el análisis por inbox (misma lógica que POST /api/supervisor/analyze).
 */
async function runSupervisorAnalyzeBatch({
  baseUrl,
  accountId,
  inboxId,
  branchName,
  token,
  windowHours,
  logger: externalLogger,
  trigger = 'manual'
}) {
  const resolvedBaseUrl = cleanBaseUrl(baseUrl || process.env.CHATWOOT_DEFAULT_BASE_URL || DEFAULT_BASE_URL);
  const resolvedAccountId = String(accountId || process.env.CHATWOOT_ACCOUNT_ID || '').trim();
  const resolvedToken = (token || process.env.CHATWOOT_API_TOKEN || '').trim();
  const resolvedWindowHours = Math.max(
    1,
    parseInt(
      windowHours || getSupervisorConfig().CHATWOOT_ACTIVITY_WINDOW_HOURS,
      10
    )
  );

  if (!resolvedAccountId) throw new Error('Falta accountId o CHATWOOT_ACCOUNT_ID.');
  if (!resolvedToken) {
    throw new Error('Falta token de Chatwoot: usa CHATWOOT_API_TOKEN en .env o envíalo en la petición.');
  }
  if (!openaiConfigured()) throw new Error('Falta OPENAI_API_KEY en .env.');

  const log =
    externalLogger ||
    createSupervisorRunLogger({
      inbox_id: inboxId,
      branch_name: branchName,
      account_id: resolvedAccountId,
      window_hours: resolvedWindowHours,
      trigger
    });

  log.stepStart('chatwoot_list_conversations', {
    inbox_id: inboxId,
    window_hours: resolvedWindowHours,
    trigger
  });

  const activityFetch = await fetchConversationsWithRecentActivity({
    baseUrl: resolvedBaseUrl,
    accountId: resolvedAccountId,
    inboxId,
    token: resolvedToken,
    windowHours: resolvedWindowHours,
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
    skipped_excluded_labels: skippedByLabel.length,
    trigger
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
        baseUrl: resolvedBaseUrl,
        accountId: resolvedAccountId,
        branchName,
        inboxId,
        token: resolvedToken,
        sinceUnix,
        windowHours: resolvedWindowHours,
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
  const snapshotResult =
    snapshotRows.length && supabaseConfigured()
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
    tagged_inactive_interest: taggedInactive,
    trigger
  });

  return {
    run_id: log.runId,
    analyzed: rows.length,
    fetched: conversationsFetched.length,
    eligible_after_label_filter: conversations.length,
    skipped_excluded_labels: skippedByLabel.length,
    skipped_conversations: skippedByLabel.slice(0, 100),
    activity_window_hours: resolvedWindowHours,
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
    debug: log.toJSON(),
    inbox_id: inboxId,
    branch_name: branchName,
    trigger
  };
}

module.exports = {
  runSupervisorAnalyzeBatch
};
