const { fetchMessagesForAnalysis } = require('../services/chatwoot.service');
const { fetchPreviousReport, fetchSnapshotHistory } = require('../services/supabase.service');
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
  mergeCompleteProjectPolicyIntoAnalysis,
  detectCompleteProjectPolicyInMessages
} = require('../services/supervisor.service');
const { getSubmitToolDescription } = require('../supervisor/playbook');
const { normalizeSupervisionAnalysis } = require('../supervisor/analysis-normalize');

const SNAPSHOT_HISTORY_LIMIT = 14;

/**
 * @param {object} params
 * @returns {object} ctx
 */
function createToolContext(params) {
  return {
    ...params,
    toolTrace: [],
    cache: {}
  };
}

function trace(ctx, name, detail = {}) {
  const entry = { tool: name, at: new Date().toISOString(), ...detail };
  ctx.toolTrace.push(entry);
  ctx.logger?.debug('agent_tool', entry);
  return entry;
}

function validateAnalysisShape(analysis) {
  return normalizeSupervisionAnalysis(analysis);
}

async function toolGetPreviousReport(ctx) {
  if (ctx.cache.previousReport !== undefined) {
    return { cached: true, has_previous: Boolean(ctx.cache.previousReport) };
  }
  const previousReport = await fetchPreviousReport(ctx.conversation.id);
  ctx.cache.previousReport = previousReport;
  ctx.cache.storedHistorical = buildStoredHistoricalContext(previousReport);
  trace(ctx, 'get_previous_report', { has_previous: Boolean(previousReport) });
  return {
    has_previous: Boolean(previousReport),
    analyzed_at: previousReport?.analyzed_at || null,
    stage: previousReport?.stage || null,
    risk_level: previousReport?.risk_level || null,
    summary_preview: (previousReport?.summary || '').slice(0, 200)
  };
}

async function toolGetRecentMessages(ctx) {
  if (ctx.cache.recentMessages) {
    return { cached: true, message_count: ctx.cache.recentMessages.length };
  }
  const recentMessages = await fetchMessagesForAnalysis({
    baseUrl: ctx.baseUrl,
    accountId: ctx.accountId,
    conversationId: ctx.conversation.id,
    token: ctx.token,
    sinceUnix: ctx.sinceUnix,
    fullHistory: Boolean(ctx.fullHistory),
    logger: ctx.logger
  });
  ctx.cache.recentMessages = recentMessages;
  trace(ctx, 'get_recent_messages', {
    message_count: recentMessages.length,
    full_history: Boolean(ctx.fullHistory)
  });
  return {
    message_count: recentMessages.length,
    window_hours: ctx.fullHistory ? null : ctx.windowHours,
    full_history: Boolean(ctx.fullHistory),
    sample_message_ids: recentMessages.slice(-3).map(m => m.id)
  };
}

async function toolGetSnapshotHistory(ctx, args = {}) {
  const limit = Math.min(parseInt(args.limit || SNAPSHOT_HISTORY_LIMIT, 10), 30);
  if (!ctx.cache.snapshotHistory) {
    ctx.cache.snapshotHistory = await fetchSnapshotHistory(ctx.conversation.id, limit);
    trace(ctx, 'get_snapshot_history', { count: ctx.cache.snapshotHistory.length });
  }
  return {
    snapshot_count: ctx.cache.snapshotHistory.length,
    dates: ctx.cache.snapshotHistory.map(s => s.snapshot_date)
  };
}

async function toolComputeBusinessFacts(ctx) {
  await toolGetPreviousReport(ctx);
  await toolGetRecentMessages(ctx);
  if (!ctx.cache.snapshotHistory) {
    await toolGetSnapshotHistory(ctx, {});
  }

  const previousReport = ctx.cache.previousReport;
  const storedHistorical = ctx.cache.storedHistorical;
  const recentMessages = ctx.cache.recentMessages || [];
  const snapshotHistory = ctx.cache.snapshotHistory || [];
  const actualInboxId = ctx.conversation.inbox_id || ctx.inboxId;

  const metricsMerged = mergeMetricsForAnalysis(
    ctx.fullHistory ? null : previousReport?.metrics,
    recentMessages,
    ctx.windowHours,
    { fullHistory: Boolean(ctx.fullHistory) }
  );
  const metrics = extendMetricsWithFollowup(recentMessages, ctx.snapshotDate, metricsMerged);
  const quoteRecent = detectQuoteInMessages(recentMessages, actualInboxId, ctx.branchName);
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

  const enrichment = buildAnalysisEnrichment({
    recentMessages,
    metrics,
    previousReport,
    snapshotHistory,
    quoteDetection,
    inactivityTagging,
    storedHistorical: ctx.fullHistory ? null : storedHistorical,
    activityWindowHours: ctx.windowHours,
    fullHistory: Boolean(ctx.fullHistory)
  });
  metrics.new_messages_at_analysis =
    enrichment.activity_delta.new_messages_since_last_analysis;

  ctx.cache.metricsMerged = metricsMerged;
  ctx.cache.metrics = metrics;
  ctx.cache.quoteDetection = quoteDetection;
  ctx.cache.inactivityTagging = inactivityTagging;
  ctx.cache.enrichment = enrichment;

  trace(ctx, 'compute_business_facts', {
    cotizacion_enviada: quoteDetection.cotizacion_enviada,
    complete_project_policy: enrichment.complete_project_policy?.communicated || false,
    analysis_mode: enrichment.analysis_mode,
    new_messages_since_last: enrichment.activity_delta.new_messages_since_last_analysis
  });

  return {
    analysis_mode: enrichment.analysis_mode,
    quote_detection: {
      cotizacion_enviada: quoteDetection.cotizacion_enviada,
      cotizacion_domain: quoteDetection.cotizacion_domain || null,
      cotizacion_evidence: quoteDetection.cotizacion_evidence || null
    },
    complete_project_policy: enrichment.complete_project_policy || { communicated: false },
    inactivity: {
      days_since_last_interaction: inactivityTagging.days_since_last_interaction,
      tagged_inactive_with_interest: inactivityTagging.tagged_inactive_with_interest,
      supervisor_tags: inactivityTagging.supervisor_tags
    },
    activity_delta: enrichment.activity_delta,
    enrichment_for_llm: {
      previous_report: enrichment.previous_report,
      snapshot_timeline: enrichment.snapshot_timeline,
      followup_tracking: enrichment.followup_tracking,
      analysis_instructions: enrichment.analysis_instructions,
      transcripts: {
        ultimas_horas_chatwoot: {
          message_count: enrichment.transcripts?.ultimas_horas_chatwoot?.message_count,
          transcript_preview: (enrichment.transcripts?.ultimas_horas_chatwoot?.transcript || '').slice(0, 4000)
        },
        historico_resumido_bd: enrichment.transcripts?.historico_resumido_bd
          ? {
            transcript_preview: (enrichment.transcripts.historico_resumido_bd.transcript || '').slice(0, 3000)
          }
          : null,
        nuevo_desde_ultimo_analisis: {
          message_count: enrichment.transcripts?.nuevo_desde_ultimo_analisis?.message_count
        }
      }
    },
    metrics_summary: {
      message_count: metrics.message_count,
      inbound_count: metrics.inbound_count,
      outbound_count: metrics.outbound_count,
      ai_agent_outbound_count: metrics.ai_agent_outbound_count,
      architect_outbound_count: metrics.architect_outbound_count
    }
  };
}

function toolSubmitSupervisionAnalysis(ctx, args) {
  if (!ctx.cache.quoteDetection || !ctx.cache.enrichment) {
    throw new Error('Debes llamar compute_business_facts antes de submit_supervision_analysis.');
  }
  const raw = validateAnalysisShape(args.analysis);
  let analysis = mergeQuoteDetectionIntoAnalysis(raw, ctx.cache.quoteDetection);
  analysis = mergeInactivityTagging(analysis, ctx.cache.inactivityTagging);
  analysis = mergeCompleteProjectPolicyIntoAnalysis(
    analysis,
    ctx.cache.enrichment?.complete_project_policy ||
      detectCompleteProjectPolicyInMessages(ctx.cache.recentMessages || [])
  );
  ctx.finalAnalysis = analysis;
  trace(ctx, 'submit_supervision_analysis', {
    stage: analysis.stage,
    risk_level: analysis.risk_level
  });
  return {
    ok: true,
    stage: analysis.stage,
    risk_level: analysis.risk_level,
    score_general: analysis.score_general
  };
}

function getOpenAIToolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'get_previous_report',
        description:
          'Obtiene el reporte de supervisión previo de esta conversación en Supabase (resumen, etapa, métricas).',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_recent_messages',
        description:
          'Obtiene mensajes públicos de Chatwoot en la ventana de actividad reciente (p. ej. últimas 24h).',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_snapshot_history',
        description: 'Obtiene snapshots diarios de seguimiento de los últimos días.',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'integer', description: 'Máximo de snapshots (default 14)' }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'compute_business_facts',
        description:
          'Calcula métricas, detección de cotización por URL, inactividad y arma enrichment para el análisis. Llamar después de mensajes e historial.',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
      }
    },
    {
      type: 'function',
      function: {
        name: 'submit_supervision_analysis',
        description: getSubmitToolDescription(),
        parameters: {
          type: 'object',
          properties: {
            analysis: {
              type: 'object',
              description: 'Objeto JSON del análisis de supervisión completo'
            }
          },
          required: ['analysis'],
          additionalProperties: false
        }
      }
    }
  ];
}

async function executeTool(name, args, ctx) {
  switch (name) {
    case 'get_previous_report':
      return toolGetPreviousReport(ctx);
    case 'get_recent_messages':
      return toolGetRecentMessages(ctx);
    case 'get_snapshot_history':
      return toolGetSnapshotHistory(ctx, args || {});
    case 'compute_business_facts':
      return toolComputeBusinessFacts(ctx);
    case 'submit_supervision_analysis':
      return toolSubmitSupervisionAnalysis(ctx, args || {});
    default:
      throw new Error(`Herramienta desconocida: ${name}`);
  }
}

module.exports = {
  createToolContext,
  getOpenAIToolDefinitions,
  executeTool
};
