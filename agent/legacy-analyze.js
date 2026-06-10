const { fetchMessagesForAnalysis } = require('../services/chatwoot.service');
const { fetchPreviousReport, fetchSnapshotHistory } = require('../services/supabase.service');
const { analyzeWithOpenAI } = require('../services/openai.service');
const {
  buildStoredHistoricalContext,
  mergeMetricsForAnalysis,
  mergeQuoteDetectionWithStored,
  buildInactivityTagging,
  buildAnalysisEnrichment,
  detectQuoteInMessages,
  extendMetricsWithFollowup,
  mergeQuoteDetectionIntoAnalysis,
  mergeInactivityTagging
} = require('../services/supervisor.service');
const { conversationHasRecentActivity } = require('../services/chatwoot.service');

/**
 * Modo legacy: pipeline determinista + un solo prompt JSON (sin tools).
 */
async function runLegacyAnalyzeForConversation(params) {
  const {
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
    previousReport: prevIn,
    storedHistorical: histIn,
    fullHistory = false,
    forceAnalyze = false
  } = params;

  const previousReport =
    prevIn !== undefined ? prevIn : await fetchPreviousReport(conversation.id);
  const storedHistorical = fullHistory
    ? null
    : histIn !== undefined
      ? histIn
      : buildStoredHistoricalContext(previousReport);

  logger?.stepStart(`${convLabel}_chatwoot_messages`, { full_history: fullHistory });
  const recentMessages = await fetchMessagesForAnalysis({
    baseUrl,
    accountId,
    conversationId: conversation.id,
    token,
    sinceUnix,
    fullHistory,
    logger
  });
  logger?.stepEnd(`${convLabel}_chatwoot_messages`, {
    messages_count: recentMessages.length,
    full_history: fullHistory
  });

  if (
    !forceAnalyze &&
    !recentMessages.length &&
    !storedHistorical &&
    !conversationHasRecentActivity(conversation, sinceUnix)
  ) {
    throw new Error('Sin mensajes, histórico ni actividad reciente.');
  }

  if (forceAnalyze && !recentMessages.length) {
    throw new Error('No se encontraron mensajes en Chatwoot para esta conversación.');
  }

  const metricsMerged = mergeMetricsForAnalysis(
    fullHistory ? null : previousReport?.metrics,
    recentMessages,
    windowHours,
    { fullHistory }
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
    activityWindowHours: windowHours,
    fullHistory
  });
  metrics.new_messages_at_analysis =
    enrichment.activity_delta.new_messages_since_last_analysis;

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
    logger
  });
  analysis = mergeQuoteDetectionIntoAnalysis(analysis, quoteDetection);
  analysis = mergeInactivityTagging(analysis, inactivityTagging);

  return {
    recentMessages,
    metricsMerged,
    metrics,
    quoteDetection,
    inactivityTagging,
    enrichment,
    analysis
  };
}

module.exports = { runLegacyAnalyzeForConversation };
