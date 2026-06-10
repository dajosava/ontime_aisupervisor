const { loadSettings } = require('./settings.service');

const QUOTE_URL_REGIONS = {
  obregon: ['obregon.ontimecocinas.com'],
  nogales: ['nogales.ontimecocinas.com'],
  hermosillo: ['hermosillo.ontimecocinas.com']
};

const ALL_QUOTE_DOMAINS = [...new Set(Object.values(QUOTE_URL_REGIONS).flat())];

function getAiAgentSenderName() {
  return loadSettings().ai_agent_sender_name;
}

function getArchitectSenderNames() {
  return loadSettings().architect_sender_names;
}

function getInactiveDaysThreshold() {
  return loadSettings().inactive_days_threshold;
}

function getChatwootActivityWindowHours() {
  return loadSettings().chatwoot_activity_window_hours;
}

function getOpenAiTemperature() {
  return loadSettings().openai_temperature;
}

function getFollowupStages() {
  return loadSettings().followup_stages;
}

function getPlaybookVersion() {
  return loadSettings().playbook_version;
}

module.exports = {
  getAiAgentSenderName,
  getArchitectSenderNames,
  getInactiveDaysThreshold,
  getChatwootActivityWindowHours,
  getOpenAiTemperature,
  getFollowupStages,
  getPlaybookVersion,
  QUOTE_URL_REGIONS,
  ALL_QUOTE_DOMAINS
};
