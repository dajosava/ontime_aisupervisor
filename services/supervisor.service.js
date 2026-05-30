const {
  conversationAppUrl,
  conversationHasRecentActivity,
  fetchConversationMessages,
  CHATWOOT_ACTIVITY_WINDOW_HOURS
} = require('./chatwoot.service');
const {
  fetchPreviousReport,
  fetchSnapshotHistory,
  storeReports,
  storeSnapshots,
  fetchReportsForFollowup,
  fetchSnapshotsByDate
} = require('./supabase.service');
const {
  OPENAI_MODEL,
  AI_AGENT_SENDER_NAME,
  ARCHITECT_SENDER_NAMES,
  QUOTE_URL_REGIONS,
  ALL_QUOTE_DOMAINS
} = require('./openai.service');

const MAX_AI_MESSAGES = parseInt(process.env.MAX_AI_MESSAGES || '0', 10);
const MAX_TRANSCRIPT_CHARS = parseInt(process.env.MAX_TRANSCRIPT_CHARS || '100000', 10);
const INACTIVE_DAYS_THRESHOLD = Math.max(1, parseInt(process.env.INACTIVE_DAYS_THRESHOLD || '2', 10));
const INACTIVITY_TAG = 'inactiva_interes_real';
const LEGACY_INACTIVITY_TAGS = ['inactiva_25d_interes_real', INACTIVITY_TAG];
const CUSTOMER_INTEREST_KEYWORDS =
  /\b(cotiz|presupuesto|precio|costo|cocina|diseño|diseno|medidas|plano|visita|agendar|modelo|m2|metro|interesad|quiero|necesito|cuando|donde|instalacion|garantia)\b/i;

const INBOX_ID_TO_QUOTE_REGION = {
  '48': 'nogales',
  '49': 'hermosillo',
  '51': 'obregon',
  '52': 'hermosillo'
};

const SUPABASE_REPORTS_TABLE = process.env.SUPABASE_REPORTS_TABLE || 'conversation_supervision_reports';
const SUPABASE_SNAPSHOTS_TABLE = process.env.SUPABASE_SNAPSHOTS_TABLE || 'conversation_followup_snapshots';
const FOLLOWUP_TIMEZONE = process.env.FOLLOWUP_TIMEZONE || 'America/Hermosillo';
const FOLLOWUP_STAGES = (process.env.FOLLOWUP_STAGES || 'asesor_ventas,cotizacion_pendiente')
  .split(',')
  .map(stage => stage.trim())
  .filter(Boolean);

function senderName(message) {
  const sender = message?.sender || {};
  return String(sender.available_name || sender.name || sender.email || '').trim();
}

function uniqueNonEmpty(values) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

function normalizedName(value) {
  return String(value || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function isAiAgentSender(name) {
  return normalizedName(name) === normalizedName(AI_AGENT_SENDER_NAME);
}

function isArchitectSender(name) {
  const normalized = normalizedName(name);
  return ARCHITECT_SENDER_NAMES.some(architectName => normalizedName(architectName) === normalized);
}

function participantType(message) {
  if (message.private) return 'nota_privada';
  if (message.message_type === 0) return 'cliente';
  if (message.message_type === 1) {
    const name = senderName(message);
    if (isAiAgentSender(name)) return 'ai_agent';
    if (isArchitectSender(name)) return 'arquitecto';
    return 'asesor_no_catalogado';
  }
  return 'sistema';
}

function normalizeMessage(message) {
  const role = participantType(message);
  return {
    id: message.id,
    role,
    sender: senderName(message),
    sender_group: role,
    created_at: message.created_at,
    private: Boolean(message.private),
    content: message.content || '[adjunto/sin texto]'
  };
}

function getVisibleMessagesSorted(messages) {
  return messages
    .filter(message => !message.private)
    .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
}

function resolveTranscriptMessageLimit(optionMax) {
  if (optionMax != null && Number.isFinite(optionMax)) return optionMax;
  if (MAX_AI_MESSAGES <= 0) return Infinity;
  return MAX_AI_MESSAGES;
}

function formatTranscriptLine(message) {
  const date = message.created_at
    ? new Date(message.created_at * 1000).toISOString()
    : 'sin_fecha';
  const name = message.sender ? ` (${message.sender})` : '';
  return `[${date}] ${message.role}${name}: ${message.content}`;
}

/**
 * Si el texto supera el límite, conserva inicio + final (proceso de venta + lo reciente).
 */
function applyTranscriptCharLimit(normalized, maxChars) {
  const lines = normalized.map(formatTranscriptLine);
  const full = lines.join('\n');
  if (full.length <= maxChars) {
    return {
      transcript: full,
      truncated: false,
      omitted_count: 0,
      total_messages: normalized.length
    };
  }

  const headCount = Math.min(50, Math.max(15, Math.floor(normalized.length * 0.12)));
  const headMessages = normalized.slice(0, headCount);
  const headText = headMessages.map(formatTranscriptLine).join('\n');
  const omittedMiddle = normalized.length - headCount;
  const separator =
    `\n\n[... ${omittedMiddle} mensajes intermedios omitidos por límite de caracteres; ` +
    'se muestran el inicio de la conversación y el tramo más reciente ...]\n\n';

  const tailBudget = Math.max(2000, maxChars - headText.length - separator.length);
  const tailMessages = [];
  for (let i = normalized.length - 1; i >= headCount; i -= 1) {
    const candidate = [...tailMessages, normalized[i]];
    const candidateText = candidate.map(formatTranscriptLine).join('\n');
    if (candidateText.length > tailBudget && tailMessages.length) break;
    tailMessages.unshift(normalized[i]);
    if (candidateText.length >= tailBudget) break;
  }

  const omittedCount = normalized.length - headMessages.length - tailMessages.length;
  const transcript = `${headText}${separator}${tailMessages.map(formatTranscriptLine).join('\n')}`;

  return {
    transcript,
    truncated: true,
    omitted_count: omittedCount,
    total_messages: normalized.length,
    head_messages: headMessages.length,
    tail_messages: tailMessages.length
  };
}

function buildTranscript(messages, options = {}) {
  const {
    sinceIso,
    maxMessages: optionMax,
    label = 'completo',
    maxChars = MAX_TRANSCRIPT_CHARS
  } = options;
  const totalFetched = messages.length;
  let visible = getVisibleMessagesSorted(messages);

  if (sinceIso) {
    const sinceUnix = Math.floor(new Date(sinceIso).getTime() / 1000);
    visible = visible.filter(message => Number(message.created_at || 0) > sinceUnix);
  } else {
    const limit = resolveTranscriptMessageLimit(optionMax);
    if (Number.isFinite(limit)) visible = visible.slice(-limit);
  }

  const normalized = visible.map(normalizeMessage);
  const limited = applyTranscriptCharLimit(normalized, maxChars);

  return {
    label,
    visible: normalized,
    transcript: limited.transcript,
    message_count: normalized.length,
    truncated: limited.truncated,
    omitted_count: limited.omitted_count || 0,
    total_fetched_messages: totalFetched,
    total_visible_messages: getVisibleMessagesSorted(messages).length,
    transcript_scope: sinceIso ? 'solo_nuevos' : 'historico_completo',
    since_iso: sinceIso || null,
    head_messages: limited.head_messages ?? null,
    tail_messages: limited.tail_messages ?? null
  };
}

function computeMetrics(messages) {
  const visible = messages
    .filter(message => !message.private)
    .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  const inbound = visible.filter(message => message.message_type === 0);
  const outbound = visible.filter(message => message.message_type === 1);
  const aiAgentOutbound = outbound.filter(message => isAiAgentSender(senderName(message)));
  const architectOutbound = outbound.filter(message => isArchitectSender(senderName(message)));
  const uncataloguedOutbound = outbound.filter(message => {
    const name = senderName(message);
    return !isAiAgentSender(name) && !isArchitectSender(name);
  });
  const aiAgentNames = uniqueNonEmpty(aiAgentOutbound.map(senderName));
  const architectNames = uniqueNonEmpty(architectOutbound.map(senderName));
  const uncataloguedNames = uniqueNonEmpty(uncataloguedOutbound.map(senderName));
  const last = visible[visible.length - 1] || null;
  const lastOutbound = outbound[outbound.length - 1] || null;
  const lastInbound = inbound[inbound.length - 1] || null;

  const firstInbound = inbound[0];
  const firstOutboundAfterInbound = firstInbound
    ? outbound.find(message => message.created_at >= firstInbound.created_at)
    : null;
  const firstResponseSeconds = firstInbound && firstOutboundAfterInbound
    ? firstOutboundAfterInbound.created_at - firstInbound.created_at
    : null;

  return {
    message_count: visible.length,
    inbound_count: inbound.length,
    outbound_count: outbound.length,
    ai_agent_outbound_count: aiAgentOutbound.length,
    architect_outbound_count: architectOutbound.length,
    uncatalogued_outbound_count: uncataloguedOutbound.length,
    ai_agent_names: aiAgentNames,
    architect_names: architectNames,
    uncatalogued_outbound_names: uncataloguedNames,
    customer_message_count: inbound.length,
    first_response_seconds: firstResponseSeconds,
    last_message_type: last?.message_type ?? null,
    last_sender_group: last ? participantType(last) : null,
    last_message_at: last?.created_at ? new Date(last.created_at * 1000).toISOString() : null,
    last_outbound_at: lastOutbound?.created_at ? new Date(lastOutbound.created_at * 1000).toISOString() : null,
    last_inbound_at: lastInbound?.created_at ? new Date(lastInbound.created_at * 1000).toISOString() : null,
    last_outbound_sender: lastOutbound ? senderName(lastOutbound) : '',
    last_outbound_sender_group: lastOutbound ? participantType(lastOutbound) : null,
    ai_agent_sender_name: AI_AGENT_SENDER_NAME,
    architect_sender_names: ARCHITECT_SENDER_NAMES
  };
}

function pickLatestIso(...values) {
  let best = null;
  let bestMs = 0;
  for (const value of values) {
    if (!value) continue;
    const ms = new Date(value).getTime();
    if (!Number.isFinite(ms)) continue;
    if (ms >= bestMs) {
      bestMs = ms;
      best = new Date(ms).toISOString();
    }
  }
  return best;
}

function computeInactivityStatus(messages, lastMessageAtIso = null) {
  const visible = getVisibleMessagesSorted(messages);
  const last = visible[visible.length - 1] || null;
  const lastAtIso =
    lastMessageAtIso ||
    (last?.created_at ? new Date(Number(last.created_at) * 1000).toISOString() : null);

  if (!lastAtIso) {
    return {
      days_since_last_interaction: null,
      last_interaction_at: null,
      last_interaction_role: last ? participantType(last) : null
    };
  }

  const lastMs = new Date(lastAtIso).getTime();
  const days = Math.floor((Date.now() - lastMs) / (1000 * 60 * 60 * 24));
  return {
    days_since_last_interaction: days,
    last_interaction_at: lastAtIso,
    last_interaction_role: last ? participantType(last) : null
  };
}

function detectRealCustomerInterest(messages, metrics, quoteDetection, storedHistorical = null) {
  const visible = getVisibleMessagesSorted(messages);
  const inbound = visible.filter(message => message.message_type === 0);
  const inboundTexts = inbound
    .map(message => String(message.content || '').trim())
    .filter(Boolean);
  const signals = [];

  if (quoteDetection?.cotizacion_enviada) signals.push('cotizacion_enviada');
  if ((metrics.customer_message_count || 0) >= 3) signals.push('cliente_activo');
  else if ((metrics.customer_message_count || 0) >= 2) signals.push('cliente_multiples_mensajes');

  const substantiveInbound = inboundTexts.filter(
    text => text.length >= 25 || CUSTOMER_INTEREST_KEYWORDS.test(text)
  );
  if (substantiveInbound.length) signals.push('mensajes_con_intencion_comercial');

  const humanOutbound =
    (metrics.architect_outbound_count || 0) > 0 || (metrics.uncatalogued_outbound_count || 0) > 0;
  if (humanOutbound && inbound.length) signals.push('seguimiento_humano');

  if ((metrics.ai_agent_outbound_count || 0) > 0 && inbound.length >= 2) {
    signals.push('dialogo_ai_y_cliente');
  }

  const storedQuote = storedHistorical?.metrics_snapshot?.quote_detection;
  if (storedQuote?.cotizacion_enviada) signals.push('cotizacion_previa_en_bd');
  const storedCount = Number(storedHistorical?.metrics_snapshot?.message_count || 0);
  if (storedCount >= 3) signals.push('historial_activo_en_bd');
  if (storedHistorical?.stage && !['indefinida', 'bot_lead_inicial'].includes(storedHistorical.stage)) {
    signals.push('etapa_avanzada_en_bd');
  }

  const onlyShortGreeting =
    inbound.length === 1 &&
    (inboundTexts[0] || '').length < 30 &&
    !CUSTOMER_INTEREST_KEYWORDS.test(inboundTexts[0] || '') &&
    !quoteDetection?.cotizacion_enviada &&
    !storedQuote?.cotizacion_enviada &&
    !humanOutbound &&
    storedCount < 2;

  return {
    real_customer_interest: signals.length > 0 && !onlyShortGreeting,
    interest_signals: uniqueNonEmpty(signals),
    excluded_as_low_intent: onlyShortGreeting
  };
}

function buildInactivityTagging(messages, metrics, quoteDetection, storedHistorical = null) {
  const inactivity = computeInactivityStatus(messages, metrics.last_message_at);
  const interest = detectRealCustomerInterest(messages, metrics, quoteDetection, storedHistorical);
  const inactiveThresholdMet =
    Number.isFinite(inactivity.days_since_last_interaction) &&
    inactivity.days_since_last_interaction >= INACTIVE_DAYS_THRESHOLD;
  const tagged = inactiveThresholdMet && interest.real_customer_interest;

  return {
    ...inactivity,
    ...interest,
    inactive_threshold_days: INACTIVE_DAYS_THRESHOLD,
    inactive_threshold_met: inactiveThresholdMet,
    supervisor_tags: tagged ? [INACTIVITY_TAG] : [],
    tagged_inactive_with_interest: tagged
  };
}

function mergeInactivityTagging(analysis, tagging) {
  const next = { ...analysis };
  if (!tagging?.tagged_inactive_with_interest) return next;

  const days = tagging.days_since_last_interaction;
  const tagLabel = `Inactiva ${days}+ días sin interacción · interés comercial real`;
  const detail =
    tagging.interest_signals?.length ? ` (${tagging.interest_signals.join(', ')})` : '';

  next.supervisor_tags = uniqueNonEmpty([
    ...(Array.isArray(next.supervisor_tags) ? next.supervisor_tags : []),
    INACTIVITY_TAG
  ]);
  next.alerts = uniqueNonEmpty([
    ...(Array.isArray(next.alerts) ? next.alerts : []),
    `${tagLabel}${detail}`
  ]);
  next.requires_human_review = true;
  next.missed_followups = true;

  if (['indefinida', 'bot_lead_inicial', 'asesor_ventas'].includes(next.stage)) {
    next.stage = 'oportunidad_inactiva';
  }

  const spa = { ...(next.sales_process_analysis || {}) };
  spa.seguimiento_comercial = spa.seguimiento_comercial || 'ausente';
  spa.proximo_paso_comercial =
    spa.proximo_paso_comercial ||
    `Reactivar conversación: lleva ${days} días sin actividad y hubo interés comercial previo.`;
  next.sales_process_analysis = spa;
  next.recommendation =
    next.recommendation ||
    `Contactar al cliente: ${days} días sin interacción con señales de interés real (${tagging.interest_signals.join(', ')}).`;

  return next;
}



function inferQuoteRegionFromBranchName(branchName) {
  const key = normalizedName(branchName);
  if (key.includes('nog')) return 'nogales';
  if (key.includes('obregon') || key.includes('obreg') || key.includes('cenontime')) return 'obregon';
  if (key.includes('hmo') || key.includes('hermosillo') || key.includes('fb hermosillo')) return 'hermosillo';
  return null;
}

function expectedQuoteRegion(inboxId, branchName) {
  const fromInbox = INBOX_ID_TO_QUOTE_REGION[String(inboxId || '').trim()];
  if (fromInbox) return fromInbox;
  return inferQuoteRegionFromBranchName(branchName);
}

function extractMessageSearchText(message) {
  const parts = [];
  if (message?.content) parts.push(String(message.content));
  const attachments = message?.attachments;
  if (Array.isArray(attachments)) {
    for (const attachment of attachments) {
      if (!attachment || typeof attachment !== 'object') continue;
      for (const field of ['data_url', 'file_url', 'thumb_url', 'download_url', 'external_url', 'redirect_url']) {
        if (attachment[field]) parts.push(String(attachment[field]));
      }
    }
  }
  if (message?.content_attributes && typeof message.content_attributes === 'object') {
    try {
      parts.push(JSON.stringify(message.content_attributes));
    } catch {
      // ignorar
    }
  }
  return parts.join('\n');
}

function findQuoteDomainsInText(text) {
  const lower = String(text || '').toLowerCase();
  const hits = [];
  for (const [region, domains] of Object.entries(QUOTE_URL_REGIONS)) {
    for (const domain of domains) {
      if (lower.includes(domain.toLowerCase())) {
        hits.push({ region, domain });
      }
    }
  }
  return hits;
}

function extractQuoteSnippet(text, domain, maxLen = 120) {
  const lower = String(text || '').toLowerCase();
  const idx = lower.indexOf(domain.toLowerCase());
  if (idx < 0) return domain;
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + domain.length + 60);
  let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (snippet.length > maxLen) snippet = `${snippet.slice(0, maxLen - 1)}…`;
  return snippet;
}

/**
 * Detecta cotización enviada buscando dominios oficiales en mensajes (prioriza salientes).
 */
function detectQuoteInMessages(messages, inboxId, branchName) {
  const expectedRegion = expectedQuoteRegion(inboxId, branchName);
  const visible = getVisibleMessagesSorted(messages);
  const detections = [];

  for (const message of visible) {
    const text = extractMessageSearchText(message);
    if (!text.trim()) continue;
    const hits = findQuoteDomainsInText(text);
    for (const hit of hits) {
      detections.push({
        message_id: message.id,
        created_at: message.created_at ? unixToIso(message.created_at) : null,
        message_type: message.message_type,
        sender: senderName(message),
        sender_group: participantType(message),
        is_outbound: message.message_type === 1,
        region: hit.region,
        domain: hit.domain,
        snippet: extractQuoteSnippet(text, hit.domain)
      });
    }
  }

  const outboundQuotes = detections.filter(item => item.is_outbound);
  const pool = outboundQuotes.length ? outboundQuotes : detections;
  const firstOutbound = outboundQuotes[0] || null;
  const firstAny = pool[0] || null;
  const primary = firstOutbound || firstAny;
  const cotizacionEnviada = pool.length > 0;

  return {
    cotizacion_enviada: cotizacionEnviada,
    expected_region: expectedRegion,
    matches_branch_expected: !expectedRegion || !primary || primary.region === expectedRegion,
    cotizacion_region: primary?.region || null,
    cotizacion_domain: primary?.domain || null,
    cotizacion_sent_at: primary?.created_at || null,
    cotizacion_sent_by: primary?.sender || null,
    cotizacion_message_id: primary?.message_id || null,
    cotizacion_detection_method: 'url_pattern',
    cotizacion_evidence: primary
      ? `Dominio oficial ${primary.domain} (${primary.region}) en mensaje ${primary.is_outbound ? 'saliente' : 'entrante'} · ${primary.sender}`
      : '',
    outbound_quote_link_count: outboundQuotes.length,
    total_quote_link_count: detections.length,
    quote_domains_catalog: ALL_QUOTE_DOMAINS,
    detections
  };
}

function mergeQuoteDetectionIntoAnalysis(analysis, quoteDetection) {
  const next = { ...analysis };
  next.sales_process_analysis = { ...(next.sales_process_analysis || {}) };
  const spa = next.sales_process_analysis;

  next.quote_detection = quoteDetection;

  if (!quoteDetection?.cotizacion_enviada) {
    spa.cotizacion_detection_source = spa.cotizacion_enviada
      ? (spa.cotizacion_detection_source || 'ai_inference')
      : 'url_pattern_not_found';
    if (!spa.cotizacion_enviada) spa.cotizacion_enviada = false;
    next.sales_process_analysis = spa;
    return next;
  }

  spa.cotizacion_enviada = true;
  spa.cotizacion_detection_source = 'url_pattern';
  spa.cotizacion_url_domain = quoteDetection.cotizacion_domain;
  spa.cotizacion_region = quoteDetection.cotizacion_region;
  spa.cotizacion_sent_at = quoteDetection.cotizacion_sent_at;
  spa.cotizacion_evidence = quoteDetection.cotizacion_evidence || spa.cotizacion_evidence;
  if (!spa.funnel_stage || spa.funnel_stage === 'asesor_ventas' || spa.funnel_stage === 'indefinida') {
    spa.funnel_stage = 'cotizacion_enviada';
  }

  if (['bot_lead_inicial', 'asesor_ventas', 'indefinida'].includes(next.stage)) {
    next.stage = 'cotizacion_pendiente';
  }

  if (!quoteDetection.matches_branch_expected && quoteDetection.expected_region) {
    next.alerts = [...(Array.isArray(next.alerts) ? next.alerts : []), `Cotización con dominio ${quoteDetection.cotizacion_region}; sucursal esperada: ${quoteDetection.expected_region}`];
  }

  next.sales_process_analysis = spa;
  return next;
}





function buildStoredHistoricalContext(previousReport) {
  if (!previousReport) return null;
  const metrics = previousReport.metrics || {};
  const spa =
    previousReport.raw_analysis?.sales_process_analysis ||
    metrics.sales_process_analysis ||
    {};
  const narrative = uniqueNonEmpty([
    previousReport.summary,
    previousReport.recommendation,
    spa.proceso_venta_resumen,
    spa.seguimiento_resumen,
    spa.proximo_paso_comercial,
    previousReport.ai_agent_summary,
    previousReport.architect_summary
  ]).join('\n');

  return {
    source: 'supabase',
    analyzed_at: previousReport.analyzed_at,
    stage: previousReport.stage,
    risk_level: previousReport.risk_level,
    score_general: previousReport.score_general,
    summary: previousReport.summary,
    recommendation: previousReport.recommendation,
    customer_sentiment: previousReport.customer_sentiment,
    missed_followups: previousReport.missed_followups,
    alerts: previousReport.alerts || [],
    ai_agent_summary: previousReport.ai_agent_summary,
    architect_summary: previousReport.architect_summary,
    metrics_snapshot: {
      message_count: metrics.message_count,
      inbound_count: metrics.inbound_count,
      outbound_count: metrics.outbound_count,
      last_message_at: metrics.last_message_at,
      last_inbound_at: metrics.last_inbound_at,
      last_outbound_at: metrics.last_outbound_at,
      quote_detection: metrics.quote_detection || null,
      inactivity_tagging: metrics.inactivity_tagging || null,
      supervisor_tags: metrics.supervisor_tags || []
    },
    sales_process_analysis: spa,
    narrative_for_ai: narrative
  };
}

function mergeMetricsForAnalysis(storedMetrics, recentMessages, windowHours) {
  const recent = computeMetrics(recentMessages);
  if (!storedMetrics || !Object.keys(storedMetrics).length) {
    return {
      ...recent,
      fetch_mode: 'solo_ultimas_horas_chatwoot',
      chatwoot_activity_window_hours: windowHours,
      messages_fetched_from_chatwoot: recentMessages.length
    };
  }

  const stored = { ...storedMetrics };
  const lastMessageAt = pickLatestIso(stored.last_message_at, recent.last_message_at);
  return {
    ...stored,
    fetch_mode: 'bd_historico_mas_ultimas_horas_chatwoot',
    chatwoot_activity_window_hours: windowHours,
    messages_fetched_from_chatwoot: recentMessages.length,
    recent_window: recent,
    new_messages_in_fetch_window: recent.message_count,
    last_message_at: lastMessageAt,
    last_inbound_at: pickLatestIso(stored.last_inbound_at, recent.last_inbound_at),
    last_outbound_at: pickLatestIso(stored.last_outbound_at, recent.last_outbound_at),
    message_count: Math.max(Number(stored.message_count) || 0, Number(recent.message_count) || 0),
    inbound_count: Math.max(Number(stored.inbound_count) || 0, Number(recent.inbound_count) || 0),
    outbound_count: Math.max(Number(stored.outbound_count) || 0, Number(recent.outbound_count) || 0),
    ai_agent_outbound_count: Math.max(
      Number(stored.ai_agent_outbound_count) || 0,
      Number(recent.ai_agent_outbound_count) || 0
    ),
    architect_outbound_count: Math.max(
      Number(stored.architect_outbound_count) || 0,
      Number(recent.architect_outbound_count) || 0
    ),
    ai_agent_names: uniqueNonEmpty([...(stored.ai_agent_names || []), ...(recent.ai_agent_names || [])]),
    architect_names: uniqueNonEmpty([...(stored.architect_names || []), ...(recent.architect_names || [])]),
    uncatalogued_outbound_names: uniqueNonEmpty([
      ...(stored.uncatalogued_outbound_names || []),
      ...(recent.uncatalogued_outbound_names || [])
    ])
  };
}

function mergeQuoteDetectionWithStored(recentDetection, storedHistorical) {
  const stored = storedHistorical?.metrics_snapshot?.quote_detection;
  if (!stored?.cotizacion_enviada) return recentDetection;
  if (recentDetection?.cotizacion_enviada) return recentDetection;
  return { ...stored, detection_source: 'bd_previo' };
}



function summarizeSnapshotForAi(snapshot) {
  if (!snapshot) return null;
  return {
    snapshot_date: snapshot.snapshot_date,
    stage: snapshot.stage,
    message_count: snapshot.message_count,
    human_outbound_today: snapshot.human_outbound_today,
    human_outbound_count: snapshot.human_outbound_count,
    last_message_at: snapshot.last_message_at,
    last_human_outbound_at: snapshot.last_human_outbound_at,
    last_inbound_at: snapshot.last_inbound_at,
    cliente_sin_respuesta: Boolean(snapshot.metrics?.cliente_sin_respuesta)
  };
}

function metricsAsTodaySnapshot(metrics, snapshotDate) {
  return {
    snapshot_date: snapshotDate,
    message_count: metrics.message_count || 0,
    human_outbound_today: Boolean(metrics.human_outbound_today),
    last_message_at: metrics.last_message_at || null,
    last_human_outbound_at: metrics.last_human_outbound_at || null,
    last_inbound_at: metrics.last_inbound_at || null,
    metrics
  };
}

function buildAnalysisEnrichment({
  recentMessages,
  metrics,
  previousReport,
  snapshotHistory,
  quoteDetection,
  inactivityTagging,
  storedHistorical,
  activityWindowHours
}) {
  const snapshotDate = calendarDateInTimezone();
  const yesterdayDate = addCalendarDays(snapshotDate, -1);
  const history = snapshotHistory || [];
  const todaySnap = history.find(snap => snap.snapshot_date === snapshotDate) || null;
  const yesterdaySnap = history.find(snap => snap.snapshot_date === yesterdayDate) || null;
  const previousAnalyzedAt = previousReport?.analyzed_at || null;
  const previousMetrics = previousReport?.metrics || {};
  const windowHours = activityWindowHours || CHATWOOT_ACTIVITY_WINDOW_HOURS;

  const transcriptRecent = buildTranscript(recentMessages, {
    label: `ultimas_${windowHours}h_chatwoot`
  });
  const transcriptSinceLastAnalysis = previousAnalyzedAt
    ? buildTranscript(recentMessages, {
      sinceIso: previousAnalyzedAt,
      label: 'nuevo_desde_ultimo_analisis'
    })
    : buildTranscript(recentMessages, { label: 'nuevo_desde_ultimo_analisis', maxMessages: 0 });

  const transcriptFromDb = storedHistorical?.narrative_for_ai
    ? {
      label: 'historico_resumido_bd',
      transcript: storedHistorical.narrative_for_ai,
      message_count: 0,
      truncated: false,
      transcript_scope: 'resumen_analisis_previo_supabase'
    }
    : null;

  const pseudoTodaySnap = todaySnap || metricsAsTodaySnapshot(metrics, snapshotDate);
  const followupTracking = computeFollowupDiff({
    report: previousReport || { stage: 'indefinida' },
    todaySnap: pseudoTodaySnap,
    yesterdaySnap
  });

  const hasDbHistory = Boolean(storedHistorical);
  const analysisMode = hasDbHistory
    ? 'incremental_bd_mas_chatwoot_reciente'
    : transcriptRecent.message_count
      ? 'analisis_inicial_solo_ventana_reciente'
      : 'analisis_inicial';

  return {
    analysis_mode: analysisMode,
    timezone: FOLLOWUP_TIMEZONE,
    snapshot_date: snapshotDate,
    chatwoot_fetch: {
      activity_window_hours: windowHours,
      messages_fetched: recentMessages.length,
      strategy: hasDbHistory
        ? 'mensajes_recientes_chatwoot_mas_contexto_supabase'
        : 'solo_mensajes_recientes_chatwoot'
    },
    stored_historical: storedHistorical,
    previous_report: previousReport
      ? {
        analyzed_at: previousReport.analyzed_at,
        stage: previousReport.stage,
        risk_level: previousReport.risk_level,
        score_general: previousReport.score_general,
        summary: previousReport.summary,
        recommendation: previousReport.recommendation,
        missed_followups: previousReport.missed_followups,
        message_count_at_analysis: previousMetrics.message_count || null
      }
      : null,
    snapshot_timeline: history.map(summarizeSnapshotForAi).filter(Boolean),
    followup_tracking: followupTracking,
    activity_delta: {
      message_count_now: metrics.message_count || 0,
      message_count_at_last_analysis: previousMetrics.message_count || 0,
      message_count_delta: (metrics.message_count || 0) - (previousMetrics.message_count || 0),
      new_messages_in_chatwoot_window: transcriptRecent.message_count,
      new_messages_since_last_analysis: transcriptSinceLastAnalysis.message_count,
      has_new_activity: transcriptRecent.message_count > 0
    },
    conversation_history: {
      messages_fetched_from_chatwoot_recent: recentMessages.length,
      has_stored_history_in_supabase: hasDbHistory,
      transcript_historico_bd: transcriptFromDb
        ? { chars: transcriptFromDb.transcript.length }
        : null,
      transcript_reciente_chatwoot: {
        messages_in_transcript: transcriptRecent.message_count,
        truncated: transcriptRecent.truncated
      }
    },
    transcripts: {
      historico_resumido_bd: transcriptFromDb,
      ultimas_horas_chatwoot: transcriptRecent,
      nuevo_desde_ultimo_analisis: transcriptSinceLastAnalysis
    },
    quote_detection: quoteDetection || { cotizacion_enviada: false },
    inactivity_tagging: inactivityTagging || null,
    analysis_instructions: [
      `Solo se trajeron de Chatwoot los mensajes de las últimas ${windowHours} horas.`,
      hasDbHistory
        ? 'El contexto histórico largo está en stored_historical y transcripts.historico_resumido_bd (análisis previo en Supabase). No asumas que falta historial si hay datos en BD.'
        : 'No hay reporte previo en Supabase: evalúa con el transcript de la ventana reciente.',
      'Prioriza transcripts.ultimas_horas_chatwoot y transcripts.nuevo_desde_ultimo_analisis para cambios recientes.',
      'Cruza activity_delta y snapshot_timeline para seguimiento día a día.',
      'En sales_process_analysis documenta cotización, espera del cliente y seguimiento comercial.',
      quoteDetection?.cotizacion_enviada
        ? `COTIZACIÓN CONFIRMADA por URL (${quoteDetection.cotizacion_domain}): evalúa seguimiento post-envío y si el cliente ya respondió.`
        : 'No se detectó URL oficial de cotización en mensajes recientes; usa historial BD si indica cotización previa.'
    ]
  };
}

function rowForReport({ conversation, contact, messages, metrics, analysis, baseUrl, accountId, branchName, inboxId }) {
  const actualInboxId = conversation.inbox_id || inboxId;
  const aiAgentAnalysis = analysis.ai_agent_analysis || {};
  const architectAnalysis = analysis.architect_analysis || {};
  const handoffAnalysis = analysis.handoff_analysis || {};
  const assigneeName = String(conversation.meta?.assignee?.name || '').trim();
  const computedAiAgentPresent = (metrics.ai_agent_outbound_count || 0) > 0;
  const computedArchitectPresent = (metrics.architect_outbound_count || 0) > 0;
  const computedArchitectNames = uniqueNonEmpty([
    ...(metrics.architect_names || []),
    computedArchitectPresent && isArchitectSender(assigneeName) ? assigneeName : ''
  ]);
  const computedAiAgentNames = uniqueNonEmpty([
    ...(metrics.ai_agent_names || []),
    computedAiAgentPresent ? AI_AGENT_SENDER_NAME : ''
  ]);
  const aiAgentPresent = computedAiAgentPresent || Boolean(aiAgentAnalysis.present);
  const architectPresent = computedArchitectPresent || Boolean(architectAnalysis.present);
  const aiAgentSummary = aiAgentAnalysis.summary ||
    (aiAgentPresent
      ? `Intervención detectada del AI Agent (${computedAiAgentNames.join(', ') || AI_AGENT_SENDER_NAME}) con ${metrics.ai_agent_outbound_count || 0} mensajes salientes.`
      : 'Sin intervención detectada del AI Agent.');
  const architectSummary = architectAnalysis.summary ||
    (architectPresent
      ? `Intervención detectada de arquitecto humano (${computedArchitectNames.join(', ') || 'sin nombre identificado'}) con ${metrics.architect_outbound_count || 0} mensajes salientes.`
      : 'Sin intervención detectada de arquitecto humano.');
  const handoffQuality = handoffAnalysis.quality ||
    (aiAgentPresent && architectPresent ? 'pendiente_revision' : 'no_aplica');
  const handoffSummary = handoffAnalysis.summary ||
    (aiAgentPresent && architectPresent
      ? 'La conversación contiene intervención del AI Agent y de al menos un arquitecto humano; revisar si el traspaso fue claro y sin pérdida de contexto.'
      : '');
  return {
    analyzed_at: new Date().toISOString(),
    chatwoot_account_id: Number(accountId),
    conversation_id: Number(conversation.id),
    conversation_url: conversationAppUrl(baseUrl, accountId, actualInboxId, conversation.id),
    inbox_id: actualInboxId != null ? Number(actualInboxId) : null,
    inbox_name: conversation.meta?.channel || `Inbox ${actualInboxId || ''}`.trim(),
    branch_name: branchName || '',
    channel_name: conversation.meta?.channel || '',
    status: conversation.status || '',
    contact_id: contact.id || null,
    contact_name: contact.name || '',
    contact_phone: contact.phone_number || '',
    contact_email: contact.email || '',
    assignee_name: assigneeName || metrics.last_outbound_sender || '',
    stage: analysis.stage || 'indefinida',
    risk_level: analysis.risk_level || 'medio',
    score_general: Number.isFinite(Number(analysis.score_general)) ? Number(analysis.score_general) : null,
    customer_sentiment: analysis.customer_sentiment || '',
    alerts: analysis.alerts || [],
    strengths: analysis.strengths || [],
    improvement_opportunities: analysis.improvement_opportunities || [],
    differentiators_detected: analysis.differentiators_detected || [],
    missed_followups: Boolean(analysis.missed_followups),
    abandoned_chat: Boolean(analysis.abandoned_chat),
    requires_human_review: Boolean(analysis.requires_human_review),
    summary: analysis.summary || '',
    recommendation: analysis.recommendation || '',
    ai_agent_present: aiAgentPresent,
    ai_agent_score: Number.isFinite(Number(aiAgentAnalysis.score)) ? Number(aiAgentAnalysis.score) : null,
    ai_agent_summary: aiAgentSummary,
    ai_agent_strengths: aiAgentAnalysis.strengths || [],
    ai_agent_issues: aiAgentAnalysis.issues || [],
    ai_agent_recommendation: aiAgentAnalysis.recommendation || '',
    architect_present: architectPresent,
    architect_names: uniqueNonEmpty([...(architectAnalysis.architect_names || []), ...computedArchitectNames]),
    architect_score: Number.isFinite(Number(architectAnalysis.score)) ? Number(architectAnalysis.score) : null,
    architect_summary: architectSummary,
    architect_strengths: architectAnalysis.strengths || [],
    architect_issues: architectAnalysis.issues || [],
    architect_recommendation: architectAnalysis.recommendation || '',
    handoff_quality: handoffQuality,
    handoff_summary: handoffSummary,
    ai_agent_outbound_count: metrics.ai_agent_outbound_count || 0,
    architect_outbound_count: metrics.architect_outbound_count || 0,
    metrics: {
      ...metrics,
      enrichment_mode: analysis.sales_process_analysis ? 'con_historial' : 'estandar',
      new_messages_at_analysis: metrics.new_messages_at_analysis ?? null,
      quote_detection: analysis.quote_detection || metrics.quote_detection || null
    },
    ai_model: OPENAI_MODEL,
    raw_analysis: analysis
  };
}



function calendarDateInTimezone(date = new Date(), timeZone = FOLLOWUP_TIMEZONE) {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(date);
}

function addCalendarDays(dateStr, days) {
  const base = new Date(`${dateStr}T12:00:00`);
  base.setDate(base.getDate() + days);
  return calendarDateInTimezone(base);
}

function unixToIso(unixSeconds) {
  if (!unixSeconds) return null;
  return new Date(Number(unixSeconds) * 1000).toISOString();
}

function isUnixOnCalendarDate(unixSeconds, dateStr) {
  if (!unixSeconds) return false;
  return calendarDateInTimezone(new Date(Number(unixSeconds) * 1000)) === dateStr;
}

function isHumanOutboundMessage(message) {
  const group = participantType(message);
  return group === 'arquitecto' || group === 'asesor_no_catalogado';
}

function extendMetricsWithFollowup(messages, snapshotDate, baseMetrics = null) {
  const visible = messages
    .filter(message => !message.private)
    .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  const outbound = visible.filter(message => message.message_type === 1);
  const humanOutbound = outbound.filter(isHumanOutboundMessage);

  let lastHumanOutboundAt = null;
  let lastHumanUnix = 0;
  let humanOutboundToday = false;

  for (const message of humanOutbound) {
    const unix = Number(message.created_at || 0);
    if (unix > lastHumanUnix) {
      lastHumanUnix = unix;
      lastHumanOutboundAt = unixToIso(unix);
    }
    if (isUnixOnCalendarDate(unix, snapshotDate)) humanOutboundToday = true;
  }

  const recent = computeMetrics(messages);
  const base = baseMetrics || recent;
  const lastInboundAt = base.last_inbound_at ? new Date(base.last_inbound_at).getTime() : 0;
  const lastOutboundAt = base.last_outbound_at ? new Date(base.last_outbound_at).getTime() : 0;
  const clienteSinRespuesta = lastInboundAt > 0 && lastInboundAt >= lastOutboundAt;

  return {
    ...base,
    human_outbound_count: Math.max(
      Number(base.human_outbound_count) || 0,
      humanOutbound.length
    ),
    human_outbound_today: humanOutboundToday || Boolean(base.human_outbound_today),
    last_human_outbound_at: pickLatestIso(base.last_human_outbound_at, lastHumanOutboundAt),
    cliente_sin_respuesta: clienteSinRespuesta
  };
}

function rowForSnapshot({ report, metrics, snapshotDate, baseUrl, accountId }) {
  const inboxId = report.inbox_id || null;
  const conversationId = Number(report.conversation_id);
  return {
    snapshot_date: snapshotDate,
    captured_at: new Date().toISOString(),
    chatwoot_account_id: Number(report.chatwoot_account_id || accountId),
    conversation_id: conversationId,
    conversation_url: report.conversation_url ||
      conversationAppUrl(baseUrl, accountId, inboxId, conversationId),
    inbox_id: inboxId != null ? Number(inboxId) : null,
    branch_name: report.branch_name || '',
    contact_id: report.contact_id || null,
    contact_name: report.contact_name || '',
    contact_phone: report.contact_phone || '',
    stage: report.stage || 'indefinida',
    risk_level: report.risk_level || null,
    message_count: metrics.message_count || 0,
    inbound_count: metrics.inbound_count || 0,
    outbound_count: metrics.outbound_count || 0,
    human_outbound_count: metrics.human_outbound_count || 0,
    human_outbound_today: Boolean(metrics.human_outbound_today),
    last_message_at: metrics.last_message_at || null,
    last_outbound_at: metrics.last_outbound_at || null,
    last_inbound_at: metrics.last_inbound_at || null,
    last_human_outbound_at: metrics.last_human_outbound_at || null,
    last_outbound_sender_group: metrics.last_outbound_sender_group || null,
    metrics
  };
}

function computeFollowupDiff({ report, todaySnap, yesterdaySnap }) {
  const changes = [];
  if (!todaySnap) {
    return {
      followup_status: 'sin_sincronizar',
      followup_label: 'Sin sincronizar hoy',
      changes,
      human_outbound_today: false,
      cliente_sin_respuesta: false,
      vs_yesterday: 'sin_snapshot_hoy'
    };
  }

  const humanToday = Boolean(todaySnap.human_outbound_today);
  const clienteSinRespuesta = Boolean(todaySnap.metrics?.cliente_sin_respuesta);

  let followupStatus = 'sin_seguimiento_hoy';
  let followupLabel = 'Sin seguimiento humano hoy';

  if (humanToday) {
    followupStatus = 'seguimiento_ok_hoy';
    followupLabel = 'Seguimiento humano hoy';
  } else if (clienteSinRespuesta) {
    followupStatus = 'cliente_sin_respuesta';
    followupLabel = 'Cliente esperando respuesta';
  }

  let vsYesterday = 'sin_snapshot_ayer';
  if (yesterdaySnap) {
    if (todaySnap.message_count > yesterdaySnap.message_count) {
      vsYesterday = 'actividad_nueva';
      changes.push(`+${todaySnap.message_count - yesterdaySnap.message_count} mensajes vs ayer`);
    } else if (
      todaySnap.message_count === yesterdaySnap.message_count &&
      todaySnap.last_message_at === yesterdaySnap.last_message_at
    ) {
      vsYesterday = 'sin_cambios';
      changes.push('Sin cambios de actividad vs ayer');
    } else {
      vsYesterday = 'actualizado';
      changes.push('Conversación actualizada vs ayer');
    }

    if (todaySnap.human_outbound_today && !yesterdaySnap.human_outbound_today) {
      changes.push('Primer seguimiento humano del día');
    }
    if (!todaySnap.human_outbound_today && yesterdaySnap.human_outbound_today) {
      changes.push('Ayer hubo seguimiento humano; hoy aún no');
    }
  }

  if (humanToday && yesterdaySnap?.last_human_outbound_at && todaySnap.last_human_outbound_at) {
    const prev = new Date(yesterdaySnap.last_human_outbound_at).getTime();
    const curr = new Date(todaySnap.last_human_outbound_at).getTime();
    if (curr > prev) changes.push('Nuevo mensaje humano saliente');
  }

  return {
    followup_status: followupStatus,
    followup_label: followupLabel,
    changes,
    human_outbound_today: humanToday,
    cliente_sin_respuesta: clienteSinRespuesta,
    vs_yesterday: vsYesterday
  };
}

function buildFollowupItems(reports, snapshots, snapshotDate) {
  const yesterdayDate = addCalendarDays(snapshotDate, -1);
  const snapByKey = new Map();
  for (const snap of snapshots) {
    snapByKey.set(`${snap.conversation_id}:${snap.snapshot_date}`, snap);
  }

  return reports.map(report => {
    const convId = Number(report.conversation_id);
    const todaySnap = snapByKey.get(`${convId}:${snapshotDate}`) || null;
    const yesterdaySnap = snapByKey.get(`${convId}:${yesterdayDate}`) || null;
    const diff = computeFollowupDiff({ report, todaySnap, yesterdaySnap });

    return {
      conversation_id: convId,
      contact_id: report.contact_id,
      contact_name: report.contact_name,
      contact_phone: report.contact_phone,
      branch_name: report.branch_name,
      inbox_id: report.inbox_id,
      stage: report.stage,
      risk_level: report.risk_level,
      conversation_url: report.conversation_url,
      recommendation: report.recommendation,
      summary: report.summary,
      analyzed_at: report.analyzed_at,
      snapshot_date: snapshotDate,
      yesterday_snapshot_date: yesterdayDate,
      today_snapshot: todaySnap,
      yesterday_snapshot: yesterdaySnap,
      ...diff
    };
  });
}

function summarizeFollowupItems(items) {
  const summary = {
    total: items.length,
    seguimiento_ok_hoy: 0,
    sin_seguimiento_hoy: 0,
    cliente_sin_respuesta: 0,
    sin_sincronizar: 0,
    actividad_nueva: 0,
    sin_cambios: 0
  };

  for (const item of items) {
    if (item.followup_status === 'seguimiento_ok_hoy') summary.seguimiento_ok_hoy += 1;
    else if (item.followup_status === 'cliente_sin_respuesta') summary.cliente_sin_respuesta += 1;
    else if (item.followup_status === 'sin_sincronizar') summary.sin_sincronizar += 1;
    else summary.sin_seguimiento_hoy += 1;

    if (item.vs_yesterday === 'actividad_nueva') summary.actividad_nueva += 1;
    if (item.vs_yesterday === 'sin_cambios') summary.sin_cambios += 1;
  }

  return summary;
}

function parseStagesParam(value) {
  if (!value) return [...FOLLOWUP_STAGES];
  return value
    .split(',')
    .map(stage => stage.trim())
    .filter(Boolean);
}

async function syncFollowupSnapshots({ baseUrl, accountId, token, inboxId, branchName, stages, limit }) {
  const reports = await fetchReportsForFollowup({ inboxId, stages, limit });
  const snapshotDate = calendarDateInTimezone();
  const rows = [];
  const errors = [];

  for (const report of reports) {
    try {
      const messages = await fetchConversationMessages({
        baseUrl,
        accountId,
        conversationId: report.conversation_id,
        token
      });
      const metrics = extendMetricsWithFollowup(messages, snapshotDate);
      rows.push(rowForSnapshot({
        report,
        metrics,
        snapshotDate,
        baseUrl,
        accountId
      }));
    } catch (err) {
      errors.push({ conversation_id: report.conversation_id, error: err.message });
    }
  }

  const storeResult = rows.length ? await storeSnapshots(rows) : { stored: false, count: 0 };
  return {
    snapshot_date: snapshotDate,
    reports_matched: reports.length,
    synced: storeResult.count,
    stored: storeResult.stored,
    errors,
    stages
  };
}


function getSupervisorConfig() {
  return {
    OPENAI_MODEL,
    SUPABASE_REPORTS_TABLE: process.env.SUPABASE_REPORTS_TABLE || 'conversation_supervision_reports',
    SUPABASE_SNAPSHOTS_TABLE: process.env.SUPABASE_SNAPSHOTS_TABLE || 'conversation_followup_snapshots',
    FOLLOWUP_TIMEZONE,
    FOLLOWUP_STAGES,
    QUOTE_URL_REGIONS,
    MAX_AI_MESSAGES,
    MAX_TRANSCRIPT_CHARS,
    MAX_CONVERSATION_MESSAGES: parseInt(process.env.MAX_CONVERSATION_MESSAGES || '3000', 10),
    CHATWOOT_MESSAGES_PAGE_SIZE: parseInt(process.env.CHATWOOT_MESSAGES_PAGE_SIZE || '20', 10),
    AI_AGENT_SENDER_NAME,
    ARCHITECT_SENDER_NAMES,
    INACTIVE_DAYS_THRESHOLD,
    INACTIVITY_TAG,
    LEGACY_INACTIVITY_TAGS,
    SUPERVISOR_MAX_CONVERSATIONS: parseInt(process.env.SUPERVISOR_MAX_CONVERSATIONS || '0', 10),
    SUPERVISOR_MAX_CONVERSATION_PAGES: Math.max(1, parseInt(process.env.SUPERVISOR_MAX_CONVERSATION_PAGES || '200', 10)),
    CHATWOOT_ACTIVITY_WINDOW_HOURS
  };
}

module.exports = {
  getSupervisorConfig,
  INACTIVITY_TAG,
  LEGACY_INACTIVITY_TAGS,
  FOLLOWUP_STAGES,
  FOLLOWUP_TIMEZONE,
  INACTIVE_DAYS_THRESHOLD,
  senderName,
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
  calendarDateInTimezone,
  addCalendarDays,
  extendMetricsWithFollowup,
  rowForSnapshot,
  buildFollowupItems,
  summarizeFollowupItems,
  parseStagesParam,
  syncFollowupSnapshots
};
