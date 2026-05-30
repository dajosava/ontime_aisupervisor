const OpenAI = require('openai');
const { conversationAppUrl } = require('./chatwoot.service');

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const AI_AGENT_SENDER_NAME = process.env.AI_AGENT_SENDER_NAME || 'Super Admin';
const ARCHITECT_SENDER_NAMES = (process.env.ARCHITECT_SENDER_NAMES || 'Manuel Limon,Kevin Landy,Israel Monge,Abigail Perez')
  .split(',')
  .map(name => name.trim())
  .filter(Boolean);

const QUOTE_URL_REGIONS = {
  obregon: ['obregon.ontimecocinas.com'],
  nogales: ['nogales.ontimecocinas.com', 'nogales.ontimecocibas.com'],
  hermosillo: ['hermosillo.ontimecocinas.com']
};

const ALL_QUOTE_DOMAINS = [...new Set(Object.values(QUOTE_URL_REGIONS).flat())];

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

module.exports = {
  isConfigured,
  getModel,
  OPENAI_MODEL,
  AI_AGENT_SENDER_NAME,
  ARCHITECT_SENDER_NAMES,
  QUOTE_URL_REGIONS,
  ALL_QUOTE_DOMAINS,
  analyzeWithOpenAI
};
