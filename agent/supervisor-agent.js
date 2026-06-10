const OpenAI = require('openai');
const { OPENAI_MODEL } = require('../services/openai.service');
const { analyzeWithOpenAI } = require('../services/openai.service');
const {
  mergeQuoteDetectionIntoAnalysis,
  mergeInactivityTagging
} = require('../services/supervisor.service');
const {
  getSupervisorSystemPrompt,
  getAnalysisJsonSchemaPrompt,
  getPlaybookVersion
} = require('../supervisor/playbook');
const { getOpenAiTemperature } = require('../supervisor/constants');
const {
  createToolContext,
  getOpenAIToolDefinitions,
  executeTool
} = require('./tools.registry');
const {
  getMaxAgentRounds,
  getMaxToolsPerRound,
  LEGACY_FALLBACK_ENABLED,
  isAgentAnalyzeMode,
  isLegacyAnalyzeMode
} = require('./analyze-config');

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/** @deprecated usar isAgentAnalyzeMode */
function isAgentModeEnabled() {
  return isAgentAnalyzeMode();
}

function buildAgentUserMessage({ conversation, contact, branchName, windowHours, fullHistory }) {
  const name = contact?.name || conversation.meta?.sender?.name || 'sin nombre';
  return [
    `Supervisa la conversación Chatwoot #${conversation.id} (${name})`,
    branchName ? `Sucursal: ${branchName}.` : '',
    fullHistory
      ? 'Modo historial completo: analiza TODOS los mensajes disponibles en Chatwoot para este cliente.'
      : `Ventana de actividad: ${windowHours} horas.`,
    'Usa las herramientas en el orden del playbook y termina con submit_supervision_analysis.',
    `Esquema del análisis:\n${getAnalysisJsonSchemaPrompt()}`
  ]
    .filter(Boolean)
    .join('\n');
}

async function runLegacyFallbackFromContext(ctx, params) {
  const { conversation, contact, baseUrl, accountId, branchName, inboxId, logger } = params;

  if (!ctx.cache.enrichment || !ctx.cache.metrics) {
    throw new Error('Fallback legacy: falta compute_business_facts en el agente.');
  }

  logger?.warn('agent_legacy_fallback', { conversation_id: conversation.id });

  let analysis = await analyzeWithOpenAI({
    conversation,
    contact,
    messages: ctx.cache.recentMessages || [],
    metrics: ctx.cache.metrics,
    enrichment: ctx.cache.enrichment,
    baseUrl,
    accountId,
    branchName,
    inboxId,
    logger
  });
  analysis = mergeQuoteDetectionIntoAnalysis(analysis, ctx.cache.quoteDetection);
  analysis = mergeInactivityTagging(analysis, ctx.cache.inactivityTagging);

  ctx.finalAnalysis = analysis;
  ctx.toolTrace.push({
    tool: 'legacy_fallback_analyze',
    at: new Date().toISOString(),
    reason: 'agente_sin_submit_tras_limite'
  });

  return analysis;
}

/**
 * Ejecuta el supervisor como agente con herramientas para una conversación.
 */
async function runSupervisorAgentForConversation(params) {
  if (!openai) {
    throw new Error('OPENAI_API_KEY no está configurada.');
  }

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
    fullHistory = false
  } = params;

  const ctx = createToolContext({
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
    fullHistory
  });

  const messages = [
    { role: 'system', content: getSupervisorSystemPrompt() },
    {
      role: 'user',
      content: buildAgentUserMessage({ conversation, contact, branchName, windowHours, fullHistory })
    }
  ];

  const maxRounds = getMaxAgentRounds();
  const maxToolsPerRound = getMaxToolsPerRound();
  const playbookVersion = getPlaybookVersion();

  logger?.stepStart('supervisor_agent_run', {
    conversation_id: conversation.id,
    playbook: playbookVersion,
    max_rounds: maxRounds,
    max_tools_per_round: maxToolsPerRound,
    full_history: fullHistory
  });

  const agentStarted = Date.now();
  let rounds = 0;
  let fallbackUsed = false;

  for (rounds = 1; rounds <= maxRounds; rounds++) {
    const isLastRound = rounds === maxRounds;
    let toolChoice = rounds === 1 ? 'required' : 'auto';

    if (isLastRound && !ctx.finalAnalysis && ctx.cache.enrichment) {
      messages.push({
        role: 'user',
        content:
          'Última ronda: debes llamar submit_supervision_analysis ahora con el JSON completo del análisis.'
      });
      toolChoice = 'required';
    }

    logger?.debug('agent_round', { round: rounds, tool_choice: toolChoice });

    let completion;
    try {
      completion = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        temperature: getOpenAiTemperature(),
        messages,
        tools: getOpenAIToolDefinitions(),
        tool_choice: toolChoice
      });
    } catch (err) {
      logger?.error('agent_openai_failed', { round: rounds, error: err.message });
      throw err;
    }

    const assistantMsg = completion.choices?.[0]?.message;
    if (!assistantMsg) {
      throw new Error('OpenAI no devolvió mensaje del agente.');
    }

    messages.push(assistantMsg);

    if (ctx.finalAnalysis) {
      logger?.stepEnd('supervisor_agent_run', {
        ok: true,
        rounds,
        duration_ms: Date.now() - agentStarted,
        tools_used: ctx.toolTrace.map(t => t.tool),
        fallback_used: fallbackUsed
      });
      break;
    }

    const toolCalls = (assistantMsg.tool_calls || []).slice(0, maxToolsPerRound);
    if (!toolCalls.length) {
      if (LEGACY_FALLBACK_ENABLED && ctx.cache.enrichment) {
        await runLegacyFallbackFromContext(ctx, params);
        fallbackUsed = true;
        break;
      }
      throw new Error(
        'El agente terminó sin llamar submit_supervision_analysis. ' +
          (assistantMsg.content || '').slice(0, 200)
      );
    }

    for (const toolCall of toolCalls) {
      const fnName = toolCall.function?.name;
      let fnArgs = {};
      try {
        fnArgs = JSON.parse(toolCall.function?.arguments || '{}');
      } catch {
        fnArgs = {};
      }

      logger?.info('agent_tool_call', { tool: fnName, round: rounds });

      let result;
      try {
        result = await executeTool(fnName, fnArgs, ctx);
      } catch (err) {
        result = { error: err.message };
        logger?.warn('agent_tool_error', { tool: fnName, error: err.message });
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result)
      });
    }
  }

  if (!ctx.finalAnalysis && LEGACY_FALLBACK_ENABLED && ctx.cache.enrichment) {
    await runLegacyFallbackFromContext(ctx, params);
    fallbackUsed = true;
    logger?.stepEnd('supervisor_agent_run', {
      ok: true,
      rounds,
      duration_ms: Date.now() - agentStarted,
      fallback_used: true
    });
  }

  if (!ctx.finalAnalysis) {
    logger?.stepEnd('supervisor_agent_run', { ok: false, rounds });
    throw new Error(
      `Agente supervisor agotó ${maxRounds} rondas sin submit_supervision_analysis.`
    );
  }

  return {
    analysis: ctx.finalAnalysis,
    recentMessages: ctx.cache.recentMessages || [],
    metrics: ctx.cache.metrics,
    metricsMerged: ctx.cache.metricsMerged,
    quoteDetection: ctx.cache.quoteDetection,
    inactivityTagging: ctx.cache.inactivityTagging,
    enrichment: ctx.cache.enrichment,
    agent_meta: {
      playbook_version: playbookVersion,
      rounds,
      tool_trace: ctx.toolTrace,
      fallback_used: fallbackUsed,
      max_rounds: maxRounds
    }
  };
}

module.exports = {
  isAgentModeEnabled,
  isAgentAnalyzeMode,
  isLegacyAnalyzeMode,
  runSupervisorAgentForConversation,
  getMaxAgentRounds,
  getMaxToolsPerRound
};
