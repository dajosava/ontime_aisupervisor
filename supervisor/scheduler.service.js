const cron = require('node-cron');
const { loadSettings } = require('./settings.service');
const { runSupervisorAnalyzeBatch } = require('../services/analyze-run.service');
const { syncFollowupSnapshots, getSupervisorConfig } = require('../services/supervisor.service');
const { cleanBaseUrl, DEFAULT_BASE_URL } = require('../services/chatwoot.service');
const {
  BRANCH_NAME_BY_INBOX,
  branchNameForInbox,
  normalizeCronSchedules,
  parseEnvCronSchedules,
  timeToCronExpression
} = require('./cron-config');

const DEFAULT_TIMEZONE = process.env.FOLLOWUP_TIMEZONE || 'America/Hermosillo';

/** @type {import('node-cron').ScheduledTask[]} */
let scheduledTasks = [];
let runQueue = Promise.resolve();
const lastRuns = [];
const MAX_LAST_RUNS = 30;

function resolveSchedulerConfig() {
  const settings = loadSettings();
  const envEnabled = process.env.SUPERVISOR_CRON_ENABLED === 'true';
  const envSchedules = parseEnvCronSchedules(process.env.SUPERVISOR_CRON_SCHEDULES);

  const fileEnabled = settings.cron_enabled;
  const fileTimezone = settings.cron_timezone || DEFAULT_TIMEZONE;
  const fileSchedules = normalizeCronSchedules(settings.cron_schedules || []);
  const syncFollowup =
    settings.cron_sync_followup != null
      ? Boolean(settings.cron_sync_followup)
      : process.env.SUPERVISOR_CRON_SYNC_FOLLOWUP !== 'false';

  const hasFileSchedules = fileSchedules.length > 0;
  const enabled =
    fileEnabled != null
      ? Boolean(fileEnabled)
      : envEnabled || (hasFileSchedules && settings.source === 'file');

  const schedules = hasFileSchedules ? fileSchedules : envSchedules;

  return {
    enabled: enabled && schedules.some(s => s.enabled),
    timezone: fileTimezone,
    schedules,
    sync_followup: syncFollowup,
    source: hasFileSchedules ? settings.source : envSchedules.length ? 'env' : settings.source
  };
}

function recordLastRun(entry) {
  lastRuns.unshift({
    ...entry,
    at: new Date().toISOString()
  });
  if (lastRuns.length > MAX_LAST_RUNS) lastRuns.length = MAX_LAST_RUNS;
}

function enqueueRun(fn) {
  runQueue = runQueue.then(fn, fn);
  return runQueue;
}

async function executeScheduledAnalyze(schedule, meta = {}) {
  const accountId = process.env.CHATWOOT_ACCOUNT_ID || '1';
  const baseUrl = cleanBaseUrl(process.env.CHATWOOT_DEFAULT_BASE_URL || DEFAULT_BASE_URL);
  const token = (process.env.CHATWOOT_API_TOKEN || '').trim();
  const trigger = meta.trigger || 'cron';

  const started = Date.now();
  const runMeta = {
    inbox_id: schedule.inbox_id,
    branch_name: schedule.branch_name,
    time: schedule.time,
    trigger
  };

  try {
    const result = await runSupervisorAnalyzeBatch({
      baseUrl,
      accountId,
      inboxId: schedule.inbox_id,
      branchName: schedule.branch_name,
      token,
      trigger
    });

    let followup = null;
    if (meta.syncFollowup) {
      try {
        followup = await syncFollowupSnapshots({
          baseUrl,
          accountId,
          token,
          inboxId: schedule.inbox_id,
          branchName: schedule.branch_name,
          stages: getSupervisorConfig().FOLLOWUP_STAGES,
          limit: 200
        });
      } catch (err) {
        followup = { error: err.message };
      }
    }

    const summary = {
      ...runMeta,
      status: 'completed',
      duration_ms: Date.now() - started,
      run_id: result.run_id,
      analyzed: result.analyzed,
      fetched: result.fetched,
      errors_count: (result.errors || []).length,
      followup_sync: followup
    };
    recordLastRun(summary);
    console.log(
      `[scheduler] OK inbox ${schedule.inbox_id} (${schedule.branch_name}): ${result.analyzed} analizadas`
    );
    return summary;
  } catch (err) {
    const summary = {
      ...runMeta,
      status: 'failed',
      duration_ms: Date.now() - started,
      error: err.message
    };
    recordLastRun(summary);
    console.error(`[scheduler] FALLO inbox ${schedule.inbox_id}: ${err.message}`);
    return summary;
  }
}

function stopScheduler() {
  for (const task of scheduledTasks) {
    try {
      task.stop();
    } catch {
      /* ignore */
    }
  }
  scheduledTasks = [];
}

function startScheduler() {
  stopScheduler();

  const config = resolveSchedulerConfig();
  if (!config.enabled) {
    console.log('[scheduler] Desactivado (cron_enabled=false o sin horarios).');
    return { started: false, jobs: 0, config };
  }

  let jobs = 0;
  for (const schedule of config.schedules) {
    if (!schedule.enabled) continue;
    const expression = timeToCronExpression(schedule.time);
    if (!expression) {
      console.warn(`[scheduler] Horario inválido inbox ${schedule.inbox_id}: ${schedule.time}`);
      continue;
    }
    if (!cron.validate(expression)) {
      console.warn(`[scheduler] Expresión cron inválida: ${expression}`);
      continue;
    }

    const task = cron.schedule(
      expression,
      () => {
        enqueueRun(() =>
          executeScheduledAnalyze(schedule, {
            trigger: 'cron',
            syncFollowup: config.sync_followup
          })
        );
      },
      { timezone: config.timezone }
    );

    scheduledTasks.push(task);
    jobs += 1;
    console.log(
      `[scheduler] Programado inbox ${schedule.inbox_id} (${schedule.branch_name}) ` +
        `a las ${schedule.time} · ${config.timezone} · cron: ${expression}`
    );
  }

  console.log(`[scheduler] ${jobs} tarea(s) activa(s).`);
  return { started: jobs > 0, jobs, config };
}

function reloadScheduler() {
  return startScheduler();
}

function getSchedulerStatus() {
  const config = resolveSchedulerConfig();
  return {
    enabled: config.enabled,
    timezone: config.timezone,
    sync_followup: config.sync_followup,
    schedules: config.schedules,
    active_jobs: scheduledTasks.length,
    source: config.source,
    env_cron_enabled: process.env.SUPERVISOR_CRON_ENABLED === 'true',
    env_cron_schedules: process.env.SUPERVISOR_CRON_SCHEDULES || null,
    last_runs: lastRuns.slice(0, 15),
    branch_catalog: BRANCH_NAME_BY_INBOX
  };
}

async function runSchedulerNow({ inboxId, trigger = 'manual' } = {}) {
  const config = resolveSchedulerConfig();
  const targets = inboxId
    ? config.schedules.filter(s => String(s.inbox_id) === String(inboxId))
    : config.schedules.filter(s => s.enabled);

  if (!targets.length) {
    throw new Error(inboxId ? `No hay horario configurado para inbox ${inboxId}.` : 'No hay horarios configurados.');
  }

  const results = [];
  for (const schedule of targets) {
    const result = await enqueueRun(() =>
      executeScheduledAnalyze(schedule, {
        trigger,
        syncFollowup: config.sync_followup
      })
    );
    results.push(result);
  }
  return { runs: results, count: results.length };
}

function schedulerSecretValid(req) {
  const secret = (process.env.SCHEDULER_SECRET || '').trim();
  if (!secret) return false;
  const header = (req.headers['x-scheduler-secret'] || req.headers['X-Scheduler-Secret'] || '').trim();
  return header === secret;
}

module.exports = {
  startScheduler,
  stopScheduler,
  reloadScheduler,
  getSchedulerStatus,
  runSchedulerNow,
  schedulerSecretValid,
  resolveSchedulerConfig
};
