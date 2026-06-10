const { conversationHasRecentActivity } = require('../services/chatwoot.service');
const { getConversationExcludedLabelMatches } = require('../services/chatwoot-labels.service');
const { fetchPreviousReport } = require('../services/supabase.service');
const {
  buildStoredHistoricalContext,
  mergeMetricsForAnalysis,
  mergeQuoteDetectionWithStored,
  buildInactivityTagging,
  buildAnalysisEnrichment,
  detectQuoteInMessages,
  extendMetricsWithFollowup,
  mergeQuoteDetectionIntoAnalysis,
  mergeInactivityTagging,
  rowForReport,
  rowForSnapshot,
  uniqueNonEmpty
} = require('../services/supervisor.service');
const { runSupervisorAgentForConversation } = require('./supervisor-agent');
const { runLegacyAnalyzeForConversation } = require('./legacy-analyze');
const { isLegacyAnalyzeMode } = require('./analyze-config');

/**
 * ¿Omitir conversación sin datos analizables?
 */
async function shouldSkipConversation({ conversation, sinceUnix, logger, convLabel }) {
  const previousReport = await fetchPreviousReport(conversation.id);
  const storedHistorical = buildStoredHistoricalContext(previousReport);

  if (storedHistorical) {
    return { skip: false, previousReport, storedHistorical };
  }

  if (conversationHasRecentActivity(conversation, sinceUnix)) {
    return { skip: false, previousReport: null, storedHistorical: null };
  }

  logger?.warn(`${convLabel}_skipped`, { reason: 'sin_historico_ni_actividad_reciente' });
  return { skip: true, previousReport: null, storedHistorical: null };
}

function buildReportAndSnapshot({
  conversation,
  contact,
  recentMessages,
  metricsMerged,
  metrics,
  quoteDetection,
  inactivityTagging,
  analysis,
  baseUrl,
  accountId,
  branchName,
  inboxId,
  snapshotDate,
  agentMeta
}) {
  const reportRow = rowForReport({
    conversation,
    contact,
    messages: recentMessages,
    metrics: {
      ...metricsMerged,
      ...metrics,
      quote_detection: quoteDetection,
      inactivity_tagging: inactivityTagging,
      days_since_last_interaction: inactivityTagging?.days_since_last_interaction,
      supervisor_tags: uniqueNonEmpty([
        ...(inactivityTagging?.supervisor_tags || []),
        ...(analysis.supervisor_tags || [])
      ])
    },
    analysis,
    baseUrl,
    accountId,
    branchName,
    inboxId
  });

  if (agentMeta) {
    reportRow.metrics = reportRow.metrics || {};
    reportRow.metrics.supervisor_agent_meta = agentMeta;
  }

  const snapshotRow = rowForSnapshot({
    report: reportRow,
    metrics,
    snapshotDate,
    baseUrl,
    accountId
  });

  return { reportRow, snapshotRow };
}

/**
 * Procesa una conversación: agente con tools (defecto) o legacy (opt-in).
 */
async function processConversationForAnalysis(params) {
  const {
    conversation,
    baseUrl,
    accountId,
    branchName,
    inboxId,
    token,
    sinceUnix,
    windowHours,
    snapshotDate,
    logger,
    convLabel,
    fullHistory = false,
    forceAnalyze = false
  } = params;

  const contact = conversation.meta?.sender || conversation.contact || {};

  let skipCheck;
  if (forceAnalyze) {
    const previousReport = await fetchPreviousReport(conversation.id);
    skipCheck = {
      skip: false,
      previousReport,
      storedHistorical: fullHistory ? null : buildStoredHistoricalContext(previousReport)
    };
  } else {
    const excludedLabels = getConversationExcludedLabelMatches(conversation);
    if (excludedLabels.length) {
      logger?.info(`${convLabel}_skipped`, {
        reason: 'excluded_chatwoot_label',
        matched_labels: excludedLabels
      });
      return {
        skipped: true,
        skip_reason: 'excluded_chatwoot_label',
        matched_labels: excludedLabels
      };
    }

    skipCheck = await shouldSkipConversation({ conversation, sinceUnix, logger, convLabel });
    if (skipCheck.skip) {
      return { skipped: true };
    }
  }

  if (isLegacyAnalyzeMode()) {
    logger?.info(`${convLabel}_mode`, { mode: 'legacy_single_prompt' });
    const legacy = await runLegacyAnalyzeForConversation({
      conversation,
      contact,
      baseUrl,
      accountId,
      branchName,
      inboxId,
      token,
      sinceUnix,
      windowHours,
      snapshotDate,
      logger,
      convLabel,
      previousReport: skipCheck.previousReport,
      storedHistorical: skipCheck.storedHistorical,
      fullHistory,
      forceAnalyze
    });
    const { reportRow, snapshotRow } = buildReportAndSnapshot({
      ...legacy,
      conversation,
      contact,
      baseUrl,
      accountId,
      branchName,
      inboxId,
      snapshotDate,
      agentMeta: null
    });
    return {
      skipped: false,
      reportRow,
      snapshotRow,
      agent_meta: null,
      analysis_mode: 'legacy'
    };
  }

  logger?.info(`${convLabel}_mode`, { mode: 'agent_tools_playbook_v1' });
  const agentResult = await runSupervisorAgentForConversation({
    conversation,
    contact,
    baseUrl,
    accountId,
    branchName,
    inboxId,
    token,
    sinceUnix,
    windowHours,
    snapshotDate,
    logger,
    fullHistory,
    forceAnalyze
  });

  let recentMessages = agentResult.recentMessages || [];
  if (!recentMessages.length && !skipCheck.storedHistorical && !forceAnalyze) {
    const prev = await fetchPreviousReport(conversation.id);
    if (!prev) {
      logger?.warn(`${convLabel}_skipped`, { reason: 'agente_sin_mensajes_ni_historico' });
      return { skipped: true };
    }
  }

  const { reportRow, snapshotRow } = buildReportAndSnapshot({
    conversation,
    contact,
    recentMessages: agentResult.recentMessages,
    metricsMerged: agentResult.metricsMerged,
    metrics: agentResult.metrics,
    quoteDetection: agentResult.quoteDetection,
    inactivityTagging: agentResult.inactivityTagging,
    analysis: agentResult.analysis,
    baseUrl,
    accountId,
    branchName,
    inboxId,
    snapshotDate,
    agentMeta: agentResult.agent_meta
  });

  return {
    skipped: false,
    reportRow,
    snapshotRow,
    agent_meta: agentResult.agent_meta,
    analysis_mode: agentResult.agent_meta?.fallback_used ? 'agent_with_legacy_fallback' : 'agent_tools',
    messages_fetched: recentMessages.length,
    full_history: fullHistory
  };
}

module.exports = {
  processConversationForAnalysis,
  shouldSkipConversation,
  buildReportAndSnapshot
};
