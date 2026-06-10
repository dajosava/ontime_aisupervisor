const fs = require('fs');
const path = require('path');
const { loadSettings } = require('../supervisor/settings.service');

const DEFAULTS_PATH = path.join(__dirname, '..', 'config', 'supervisor-excluded-labels.json');

let cachedExcluded = null;

function normalizeLabelKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function loadDefaultExcludedFromFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function parseExcludedLabelsEnv(value) {
  if (!value || !String(value).trim()) return null;
  return String(value)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function getExcludedChatwootLabels() {
  if (cachedExcluded) return cachedExcluded;

  try {
    const settings = loadSettings();
    if (settings.excluded_chatwoot_labels?.length) {
      cachedExcluded = [...settings.excluded_chatwoot_labels];
      return cachedExcluded;
    }
  } catch {
    /* fallback below */
  }

  const fromEnv = parseExcludedLabelsEnv(process.env.SUPERVISOR_EXCLUDED_CHATWOOT_LABELS);
  const source = fromEnv || loadDefaultExcludedFromFile();
  cachedExcluded = [...new Set(source.map(normalizeLabelKey).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, 'es')
  );
  return cachedExcluded;
}

function invalidateExcludedLabelsCache() {
  cachedExcluded = null;
}

/**
 * Extrae etiquetas Chatwoot de un objeto conversación (listado o detalle).
 */
function extractConversationLabels(conversation) {
  if (!conversation || typeof conversation !== 'object') return [];

  const collected = [];

  const push = value => {
    if (value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) push(item);
      return;
    }
    if (typeof value === 'object') {
      push(value.title);
      push(value.name);
      push(value.label);
      return;
    }
    const str = String(value).trim();
    if (!str) return;
    if (str.includes(',')) {
      for (const part of str.split(',')) push(part);
      return;
    }
    collected.push(str);
  };

  push(conversation.labels);
  push(conversation.meta?.labels);
  push(conversation.cached_label_list);

  return [...new Set(collected.map(normalizeLabelKey).filter(Boolean))];
}

function getConversationExcludedLabelMatches(conversation) {
  const excluded = new Set(getExcludedChatwootLabels());
  const onConversation = extractConversationLabels(conversation);
  return onConversation.filter(label => excluded.has(label));
}

function conversationHasExcludedLabel(conversation) {
  return getConversationExcludedLabelMatches(conversation).length > 0;
}

function partitionConversationsByExcludedLabels(conversations) {
  const eligible = [];
  const skipped = [];

  for (const conversation of conversations || []) {
    const matched_labels = getConversationExcludedLabelMatches(conversation);
    if (matched_labels.length) {
      skipped.push({
        conversation_id: conversation.id,
        matched_labels,
        contact_name: conversation.meta?.sender?.name || conversation.meta?.sender?.available_name || null,
        inbox_id: conversation.inbox_id || null
      });
    } else {
      eligible.push(conversation);
    }
  }

  return { eligible, skipped };
}

module.exports = {
  getExcludedChatwootLabels,
  invalidateExcludedLabelsCache,
  extractConversationLabels,
  getConversationExcludedLabelMatches,
  conversationHasExcludedLabel,
  partitionConversationsByExcludedLabels,
  normalizeLabelKey
};
