const OpenAI = require('openai');
const { conversationAppUrl } = require('./chatwoot.service');
const { getSupervisorSystemPrompt, getAnalysisJsonSchemaPrompt } = require('../supervisor/playbook');

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const {
  getAiAgentSenderName,
  getArchitectSenderNames,
  getOpenAiTemperature,
  QUOTE_URL_REGIONS,
  ALL_QUOTE_DOMAINS
} = require('../supervisor/constants');

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

function isConfigured() {
  return Boolean(openai);
}

function getModel() {
  return OPENAI_MODEL;
}

function analysisJsonSchemaPrompt() {
  return getAnalysisJsonSchemaPrompt();
}

async function analyzeWithOpenAI({
  conversation,
  contact,
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

  const aiAgentName = getAiAgentSenderName();
  const architectNames = getArchitectSenderNames();

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
      ai_agent_sender_name: aiAgentName,
      architect_sender_names: architectNames,
      ai_agent_rule: `Todo mensaje saliente enviado por "${aiAgentName}" pertenece al AI Agent de On Time Cocinas.`,
      architect_rule: `Solo estos usuarios salientes pertenecen a arquitectos humanos: ${architectNames.join(', ')}.`,
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

  const systemContent = getSupervisorSystemPrompt();
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
      temperature: getOpenAiTemperature(),
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

module.exports = {
  isConfigured,
  getModel,
  OPENAI_MODEL,
  getAiAgentSenderName,
  getArchitectSenderNames,
  QUOTE_URL_REGIONS,
  ALL_QUOTE_DOMAINS,
  analyzeWithOpenAI
};
