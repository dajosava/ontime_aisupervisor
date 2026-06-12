const fs = require('fs');
const path = require('path');

const SETTINGS_PATH =
  process.env.SUPERVISOR_SETTINGS_PATH ||
  path.join(__dirname, '..', 'data', 'agent-settings.json');

const BACKUPS_DIR =
  process.env.SUPERVISOR_SETTINGS_BACKUPS_DIR ||
  path.join(path.dirname(SETTINGS_PATH), 'backups');

const MAX_SETTINGS_BACKUPS = Math.max(
  5,
  parseInt(process.env.SUPERVISOR_SETTINGS_MAX_BACKUPS || '30', 10)
);

const DEFAULTS_PATH = path.join(__dirname, '..', 'config', 'agent-settings.defaults.json');

const { normalizeCronSchedules, parseEnvCronSchedules, validateCronSchedules } = require('./cron-config');

let cache = null;

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function envList(value, fallback) {
  if (!value || !String(value).trim()) return [...fallback];
  return String(value)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function uniqueSortedNames(names) {
  return [...new Set(names.map(n => String(n).trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, 'es')
  );
}

function normalizeLabelKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function loadExcludedLabelsFileDefaults() {
  try {
    const p = path.join(__dirname, '..', 'config', 'supervisor-excluded-labels.json');
    const raw = readJsonFile(p);
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function normalizeExcludedLabelsList(labels) {
  return [...new Set((labels || []).map(normalizeLabelKey).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, 'es')
  );
}

function resolveArchitectCatalog(envDefaults, merged, activeArchitects) {
  const fromFile = Array.isArray(merged.architect_catalog)
    ? merged.architect_catalog
    : envList(merged.architect_catalog, []);
  const fromDefaults = Array.isArray(envDefaults.architect_catalog)
    ? envDefaults.architect_catalog
    : envList(process.env.ARCHITECT_CATALOG, envDefaults.architect_catalog || envDefaults.architect_sender_names || []);

  return uniqueSortedNames([
    ...fromDefaults,
    ...fromFile,
    ...(envDefaults.architect_sender_names || []),
    ...(activeArchitects || [])
  ]);
}

function buildEnvDefaults() {
  let fileDefaults = {};
  try {
    fileDefaults = readJsonFile(DEFAULTS_PATH);
  } catch {
    fileDefaults = {};
  }

  return {
    playbook_version: process.env.SUPERVISOR_PLAYBOOK_VERSION || fileDefaults.playbook_version || 'v2',
    use_custom_system_prompt: false,
    system_prompt: '',
    system_prompt_extra: '',
    agent_workflow_extra: '',
    ai_agent_sender_name:
      process.env.AI_AGENT_SENDER_NAME || fileDefaults.ai_agent_sender_name || 'Super Admin',
    architect_catalog: envList(
      process.env.ARCHITECT_CATALOG,
      fileDefaults.architect_catalog || fileDefaults.architect_sender_names || []
    ),
    architect_sender_names: envList(
      process.env.ARCHITECT_SENDER_NAMES,
      fileDefaults.architect_sender_names || []
    ),
    inactive_days_threshold: Math.max(
      1,
      parseInt(process.env.INACTIVE_DAYS_THRESHOLD || String(fileDefaults.inactive_days_threshold || 2), 10)
    ),
    chatwoot_activity_window_hours: Math.max(
      1,
      parseInt(
        process.env.CHATWOOT_ACTIVITY_WINDOW_HOURS ||
          String(fileDefaults.chatwoot_activity_window_hours || 24),
        10
      )
    ),
    openai_temperature: Math.min(
      1,
      Math.max(0, parseFloat(process.env.SUPERVISOR_OPENAI_TEMPERATURE || fileDefaults.openai_temperature || 0.1))
    ),
    agent_max_rounds: Math.max(
      3,
      parseInt(process.env.SUPERVISOR_AGENT_MAX_ROUNDS || String(fileDefaults.agent_max_rounds || 10), 10)
    ),
    agent_max_tools_per_round: Math.max(
      1,
      parseInt(
        process.env.SUPERVISOR_AGENT_MAX_TOOLS_PER_ROUND ||
          String(fileDefaults.agent_max_tools_per_round || 5),
        10
      )
    ),
    followup_stages: envList(
      process.env.FOLLOWUP_STAGES,
      fileDefaults.followup_stages || ['lead', 'asesor_venta']
    ),
    excluded_chatwoot_labels: normalizeExcludedLabelsList(
      envList(
        process.env.SUPERVISOR_EXCLUDED_CHATWOOT_LABELS,
        fileDefaults.excluded_chatwoot_labels || loadExcludedLabelsFileDefaults()
      )
    ),
    cron_enabled:
      process.env.SUPERVISOR_CRON_ENABLED === 'true'
        ? true
        : process.env.SUPERVISOR_CRON_ENABLED === 'false'
          ? false
          : fileDefaults.cron_enabled ?? false,
    cron_timezone: process.env.SUPERVISOR_CRON_TIMEZONE || fileDefaults.cron_timezone || 'America/Hermosillo',
    cron_sync_followup:
      process.env.SUPERVISOR_CRON_SYNC_FOLLOWUP === 'false'
        ? false
        : fileDefaults.cron_sync_followup ?? true,
    cron_schedules: normalizeCronSchedules(
      parseEnvCronSchedules(process.env.SUPERVISOR_CRON_SCHEDULES).length
        ? parseEnvCronSchedules(process.env.SUPERVISOR_CRON_SCHEDULES)
        : fileDefaults.cron_schedules || []
    )
  };
}

function deepMerge(base, overlay) {
  return { ...base, ...overlay };
}

function normalizeSettings(raw, envDefaults) {
  const merged = deepMerge(envDefaults, raw || {});

  const architects = Array.isArray(merged.architect_sender_names)
    ? merged.architect_sender_names
    : envList(merged.architect_sender_names, envDefaults.architect_sender_names);
  const architectSenderNames = uniqueSortedNames(architects);
  const architectCatalog = resolveArchitectCatalog(envDefaults, merged, architectSenderNames);

  const stages = Array.isArray(merged.followup_stages)
    ? merged.followup_stages
    : envList(merged.followup_stages, envDefaults.followup_stages);

  return {
    playbook_version: String(merged.playbook_version || 'v2').trim(),
    use_custom_system_prompt: Boolean(merged.use_custom_system_prompt),
    system_prompt: String(merged.system_prompt || ''),
    system_prompt_extra: String(merged.system_prompt_extra || ''),
    agent_workflow_extra: String(merged.agent_workflow_extra || ''),
    ai_agent_sender_name: String(merged.ai_agent_sender_name || envDefaults.ai_agent_sender_name).trim(),
    architect_catalog: architectCatalog,
    architect_sender_names: architectSenderNames,
    inactive_days_threshold: Math.max(1, Math.min(90, parseInt(merged.inactive_days_threshold, 10) || 2)),
    chatwoot_activity_window_hours: Math.max(
      1,
      Math.min(168, parseInt(merged.chatwoot_activity_window_hours, 10) || 24)
    ),
    openai_temperature: Math.min(1, Math.max(0, Number(merged.openai_temperature) || 0.1)),
    agent_max_rounds: Math.max(3, Math.min(25, parseInt(merged.agent_max_rounds, 10) || 10)),
    agent_max_tools_per_round: Math.max(1, Math.min(10, parseInt(merged.agent_max_tools_per_round, 10) || 5)),
    followup_stages: [...new Set(stages.map(s => String(s).trim()).filter(Boolean))],
    excluded_chatwoot_labels: normalizeExcludedLabelsList(
      Array.isArray(merged.excluded_chatwoot_labels)
        ? merged.excluded_chatwoot_labels
        : envList(merged.excluded_chatwoot_labels, envDefaults.excluded_chatwoot_labels)
    ),
    cron_enabled: merged.cron_enabled != null ? Boolean(merged.cron_enabled) : Boolean(envDefaults.cron_enabled),
    cron_timezone: String(merged.cron_timezone || envDefaults.cron_timezone || 'America/Hermosillo').trim(),
    cron_sync_followup:
      merged.cron_sync_followup != null
        ? Boolean(merged.cron_sync_followup)
        : Boolean(envDefaults.cron_sync_followup),
    cron_schedules: normalizeCronSchedules(
      Array.isArray(merged.cron_schedules) ? merged.cron_schedules : envDefaults.cron_schedules
    )
  };
}

function validateSettings(settings) {
  if (!settings.ai_agent_sender_name) {
    throw new Error('El nombre del AI Agent en Chatwoot es obligatorio.');
  }
  if (!settings.architect_sender_names.length) {
    throw new Error('Debe haber al menos un arquitecto humano en la lista.');
  }
  if (settings.use_custom_system_prompt && settings.system_prompt.trim().length < 40) {
    throw new Error('El system prompt personalizado debe tener al menos 40 caracteres.');
  }
  if (settings.system_prompt.length > 50000) {
    throw new Error('El system prompt no puede superar 50 000 caracteres.');
  }
  if (settings.system_prompt_extra.length > 10000) {
    throw new Error('Las instrucciones adicionales no pueden superar 10 000 caracteres.');
  }
  if (settings.excluded_chatwoot_labels.length > 100) {
    throw new Error('Máximo 100 etiquetas excluidas.');
  }
  for (const label of settings.excluded_chatwoot_labels) {
    if (label.length > 64) {
      throw new Error(`Etiqueta demasiado larga: ${label.slice(0, 20)}…`);
    }
    if (!/^[a-z0-9_-]+$/.test(label)) {
      throw new Error(
        `Etiqueta inválida "${label}": usa solo letras minúsculas, números, guión y guión bajo.`
      );
    }
  }
  validateCronSchedules(settings.cron_schedules || []);
  if (settings.cron_timezone && settings.cron_timezone.length > 64) {
    throw new Error('Zona horaria demasiado larga.');
  }
  return settings;
}

function loadSettings({ forceReload = false } = {}) {
  if (cache && !forceReload) return cache;

  const envDefaults = buildEnvDefaults();
  let fileData = {};

  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      fileData = readJsonFile(SETTINGS_PATH);
    } catch (err) {
      throw new Error(`No se pudo leer configuración: ${err.message}`);
    }
  }

  const settings = normalizeSettings(fileData, envDefaults);
  cache = {
    ...settings,
    updated_at: fileData.updated_at || null,
    updated_by: fileData.updated_by || null,
    source: fs.existsSync(SETTINGS_PATH) ? 'file' : 'env_defaults',
    settings_path: SETTINGS_PATH
  };
  return cache;
}

function invalidateSettingsCache() {
  cache = null;
}

function persistableSettingsPayload(source) {
  const s = source || loadSettings();
  return {
    playbook_version: s.playbook_version,
    use_custom_system_prompt: s.use_custom_system_prompt,
    system_prompt: s.system_prompt,
    system_prompt_extra: s.system_prompt_extra,
    agent_workflow_extra: s.agent_workflow_extra,
    ai_agent_sender_name: s.ai_agent_sender_name,
    architect_catalog: s.architect_catalog,
    architect_sender_names: s.architect_sender_names,
    inactive_days_threshold: s.inactive_days_threshold,
    chatwoot_activity_window_hours: s.chatwoot_activity_window_hours,
    openai_temperature: s.openai_temperature,
    agent_max_rounds: s.agent_max_rounds,
    agent_max_tools_per_round: s.agent_max_tools_per_round,
    followup_stages: s.followup_stages,
    excluded_chatwoot_labels: s.excluded_chatwoot_labels,
    cron_enabled: s.cron_enabled,
    cron_timezone: s.cron_timezone,
    cron_sync_followup: s.cron_sync_followup,
    cron_schedules: s.cron_schedules,
    updated_at: s.updated_at || null,
    updated_by: s.updated_by || null
  };
}

function pruneSettingsBackups() {
  if (!fs.existsSync(BACKUPS_DIR)) return;
  const files = fs
    .readdirSync(BACKUPS_DIR)
    .filter(name => name.startsWith('agent-settings-') && name.endsWith('.json'))
    .map(name => ({
      name,
      full: path.join(BACKUPS_DIR, name),
      mtime: fs.statSync(path.join(BACKUPS_DIR, name)).mtimeMs
    }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const file of files.slice(MAX_SETTINGS_BACKUPS)) {
    try {
      fs.unlinkSync(file.full);
    } catch {
      /* ignore */
    }
  }
}

function createSettingsBackup(meta = {}) {
  const playbook = require('./playbook');
  const current = loadSettings();
  let settingsFile = null;

  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      settingsFile = readJsonFile(SETTINGS_PATH);
    } catch {
      settingsFile = persistableSettingsPayload(current);
    }
  } else {
    settingsFile = persistableSettingsPayload(current);
  }

  const backedUpAt = new Date().toISOString();
  const backupId = backedUpAt.replace(/[:.]/g, '-');
  const snapshot = {
    backup_id: backupId,
    backed_up_at: backedUpAt,
    backed_up_by: meta.updated_by || meta.email || 'system',
    reason: meta.reason || 'before_save',
    settings_file: settingsFile,
    effective_system_prompt: playbook.getSupervisorSystemPrompt()
  };

  if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  }

  const filePath = path.join(BACKUPS_DIR, `agent-settings-${backupId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
  pruneSettingsBackups();

  return {
    backup_id: backupId,
    backed_up_at: backedUpAt,
    backed_up_by: snapshot.backed_up_by,
    file: filePath
  };
}

function listSettingsBackups(limit = 25) {
  if (!fs.existsSync(BACKUPS_DIR)) return [];

  return fs
    .readdirSync(BACKUPS_DIR)
    .filter(name => name.startsWith('agent-settings-') && name.endsWith('.json'))
    .map(name => {
      const full = path.join(BACKUPS_DIR, name);
      let data = {};
      try {
        data = readJsonFile(full);
      } catch {
        data = {};
      }
      const backupId = data.backup_id || name.replace(/^agent-settings-|\.json$/g, '');
      const at = data.backed_up_at || fs.statSync(full).mtime.toISOString();
      const by = data.backed_up_by || '—';
      const reason = data.reason || 'backup';
      return {
        backup_id: backupId,
        filename: name,
        backed_up_at: at,
        backed_up_by: by,
        reason,
        label: `${new Date(at).toLocaleString('es-MX')} · ${by} · ${reason}`
      };
    })
    .sort((a, b) => String(b.backed_up_at).localeCompare(String(a.backed_up_at)))
    .slice(0, Math.min(limit, 50));
}

function restoreSettingsBackup(backupId, meta = {}) {
  if (!backupId || !String(backupId).trim()) {
    throw new Error('Falta backup_id.');
  }

  const safeId = String(backupId).trim().replace(/[^a-zA-Z0-9_-]/g, '');
  const filePath = path.join(BACKUPS_DIR, `agent-settings-${safeId}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error('Backup no encontrado.');
  }

  const backup = readJsonFile(filePath);
  if (!backup.settings_file || typeof backup.settings_file !== 'object') {
    throw new Error('El backup no contiene configuración válida.');
  }

  const preRestoreBackup = createSettingsBackup({
    email: meta.email,
    updated_by: meta.updated_by,
    reason: 'before_restore'
  });

  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(backup.settings_file, null, 2), 'utf8');
  invalidateSettingsCache();

  return {
    restored_from: safeId,
    restored_at: new Date().toISOString(),
    pre_restore_backup: preRestoreBackup,
    settings: getSettingsForApi()
  };
}

function saveSettings(updates, meta = {}) {
  const backup = createSettingsBackup({
    email: meta.email,
    updated_by: meta.updated_by,
    reason: 'before_save'
  });

  const current = loadSettings();
  const envDefaults = buildEnvDefaults();

  const merged = normalizeSettings(
    {
      ...current,
      ...updates,
      updated_at: new Date().toISOString(),
      updated_by: meta.updated_by || meta.email || 'ui'
    },
    envDefaults
  );

  validateSettings(merged);

  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const toWrite = {
    playbook_version: merged.playbook_version,
    use_custom_system_prompt: merged.use_custom_system_prompt,
    system_prompt: merged.system_prompt,
    system_prompt_extra: merged.system_prompt_extra,
    agent_workflow_extra: merged.agent_workflow_extra,
    ai_agent_sender_name: merged.ai_agent_sender_name,
    architect_catalog: merged.architect_catalog,
    architect_sender_names: merged.architect_sender_names,
    inactive_days_threshold: merged.inactive_days_threshold,
    chatwoot_activity_window_hours: merged.chatwoot_activity_window_hours,
    openai_temperature: merged.openai_temperature,
    agent_max_rounds: merged.agent_max_rounds,
    agent_max_tools_per_round: merged.agent_max_tools_per_round,
    followup_stages: merged.followup_stages,
    excluded_chatwoot_labels: merged.excluded_chatwoot_labels,
    cron_enabled: merged.cron_enabled,
    cron_timezone: merged.cron_timezone,
    cron_sync_followup: merged.cron_sync_followup,
    cron_schedules: merged.cron_schedules,
    updated_at: merged.updated_at,
    updated_by: merged.updated_by
  };

  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(toWrite, null, 2), 'utf8');
  invalidateSettingsCache();
  try {
    require('../services/chatwoot-labels.service').invalidateExcludedLabelsCache();
  } catch {
    /* ignore */
  }
  try {
    require('./scheduler.service').reloadScheduler();
  } catch (err) {
    console.warn('[scheduler] No se pudo recargar tras guardar settings:', err.message);
  }
  const saved = loadSettings({ forceReload: true });
  saved.last_backup = backup;
  return saved;
}

function resetSettings(meta = {}) {
  const envDefaults = buildEnvDefaults();
  const normalized = normalizeSettings(
    {
      ...envDefaults,
      updated_at: new Date().toISOString(),
      updated_by: meta.updated_by || meta.email || 'reset'
    },
    envDefaults
  );
  validateSettings(normalized);

  if (fs.existsSync(SETTINGS_PATH)) {
    fs.unlinkSync(SETTINGS_PATH);
  }
  invalidateSettingsCache();
  try {
    require('../services/chatwoot-labels.service').invalidateExcludedLabelsCache();
  } catch {
    /* ignore */
  }
  try {
    require('./scheduler.service').reloadScheduler();
  } catch (err) {
    console.warn('[scheduler] No se pudo recargar tras reset settings:', err.message);
  }
  return loadSettings({ forceReload: true });
}

function getSettingsForApi(extra = {}) {
  const s = loadSettings();
  const playbook = require('./playbook');
  const effective = playbook.getSupervisorSystemPrompt();
  const playbookPrompt = playbook.getPlaybookSystemPrompt();
  const extraPart = s.system_prompt_extra?.trim() || '';

  return {
    playbook_version: s.playbook_version,
    use_custom_system_prompt: s.use_custom_system_prompt,
    system_prompt: s.system_prompt,
    system_prompt_extra: s.system_prompt_extra,
    agent_workflow_extra: s.agent_workflow_extra,
    ai_agent_sender_name: s.ai_agent_sender_name,
    architect_catalog: s.architect_catalog,
    architect_sender_names: s.architect_sender_names,
    inactive_days_threshold: s.inactive_days_threshold,
    chatwoot_activity_window_hours: s.chatwoot_activity_window_hours,
    openai_temperature: s.openai_temperature,
    agent_max_rounds: s.agent_max_rounds,
    agent_max_tools_per_round: s.agent_max_tools_per_round,
    followup_stages: s.followup_stages,
    excluded_chatwoot_labels: s.excluded_chatwoot_labels,
    excluded_labels_env_override: Boolean(process.env.SUPERVISOR_EXCLUDED_CHATWOOT_LABELS?.trim()),
    cron_enabled: s.cron_enabled,
    cron_timezone: s.cron_timezone,
    cron_sync_followup: s.cron_sync_followup,
    cron_schedules: s.cron_schedules,
    cron_env_enabled: process.env.SUPERVISOR_CRON_ENABLED === 'true',
    cron_env_schedules: process.env.SUPERVISOR_CRON_SCHEDULES || null,
    scheduler: require('./scheduler.service').getSchedulerStatus(),
    updated_at: s.updated_at,
    updated_by: s.updated_by,
    source: s.source,
    openai_model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    effective_system_prompt: effective,
    effective_system_prompt_preview: effective.slice(0, 500),
    playbook_system_prompt: playbookPrompt,
    prompt_mode: s.use_custom_system_prompt ? 'personalizado' : 'playbook',
    playbook_version_env: process.env.SUPERVISOR_PLAYBOOK_VERSION || null,
    backups_available: listSettingsBackups(5).length,
    last_backup: extra.last_backup || null
  };
}

module.exports = {
  loadSettings,
  saveSettings,
  resetSettings,
  getSettingsForApi,
  createSettingsBackup,
  listSettingsBackups,
  restoreSettingsBackup,
  invalidateSettingsCache,
  buildEnvDefaults,
  SETTINGS_PATH,
  BACKUPS_DIR
};
