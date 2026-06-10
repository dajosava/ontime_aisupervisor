const { loadSettings } = require('../supervisor/settings.service');

const LEGACY_FALLBACK_ENABLED = process.env.SUPERVISOR_AGENT_LEGACY_FALLBACK !== 'false';

function getMaxAgentRounds() {
  return loadSettings().agent_max_rounds;
}

function getMaxToolsPerRound() {
  return loadSettings().agent_max_tools_per_round;
}

/** Modo legacy solo si se pide explícitamente */
function isLegacyAnalyzeMode() {
  if (process.env.SUPERVISOR_LEGACY_MODE === 'true' || process.env.SUPERVISOR_LEGACY_MODE === '1') {
    return true;
  }
  const mode = (process.env.SUPERVISOR_AGENT_MODE ?? 'true').toString().trim().toLowerCase();
  return mode === 'false' || mode === '0';
}

function isAgentAnalyzeMode() {
  return !isLegacyAnalyzeMode();
}

module.exports = {
  getMaxAgentRounds,
  getMaxToolsPerRound,
  LEGACY_FALLBACK_ENABLED,
  isLegacyAnalyzeMode,
  isAgentAnalyzeMode
};
