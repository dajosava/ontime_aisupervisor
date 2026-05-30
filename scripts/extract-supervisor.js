const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'proxy-server.js'), 'utf8');
const start = src.indexOf('function senderName(message)');
const end = src.indexOf('function getBearerToken(req)');
if (start < 0 || end < 0) {
  throw new Error(`markers not found: start=${start} end=${end}`);
}

let body = src.slice(start, end);

const removeFns = [
  'async function fetchPreviousReport',
  'async function fetchSnapshotHistory',
  'async function storeReports',
  'async function fetchReportsForFollowup',
  'async function fetchSnapshotsByDate',
  'async function storeSnapshots',
  'async function analyzeWithOpenAI',
  'function conversationAppUrl',
  'function analysisJsonSchemaPrompt'
];
for (const sig of removeFns) {
  const i = body.indexOf(sig);
  if (i < 0) continue;
  let depth = 0;
  let j = i;
  const open = body.indexOf('{', i);
  for (j = open; j < body.length; j++) {
    if (body[j] === '{') depth++;
    else if (body[j] === '}') {
      depth--;
      if (depth === 0) {
        j++;
        break;
      }
    }
  }
  body = body.slice(0, i) + body.slice(j);
}

const constants = `const MAX_AI_MESSAGES = parseInt(process.env.MAX_AI_MESSAGES || '0', 10);
const MAX_TRANSCRIPT_CHARS = parseInt(process.env.MAX_TRANSCRIPT_CHARS || '100000', 10);
const INACTIVE_DAYS_THRESHOLD = Math.max(1, parseInt(process.env.INACTIVE_DAYS_THRESHOLD || '2', 10));
const INACTIVITY_TAG = 'inactiva_interes_real';
const LEGACY_INACTIVITY_TAGS = ['inactiva_25d_interes_real', INACTIVITY_TAG];
const CUSTOMER_INTEREST_KEYWORDS =
  /\\b(cotiz|presupuesto|precio|costo|cocina|diseño|diseno|medidas|plano|visita|agendar|modelo|m2|metro|interesad|quiero|necesito|cuando|donde|instalacion|garantia)\\b/i;

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

`;

const header = `const {
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

`;

const footer = `
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
`;

const outPath = path.join(__dirname, '..', 'services', 'supervisor.service.js');
fs.writeFileSync(outPath, header + constants + body + footer);
console.log('OK', outPath, (header + body + footer).length);
