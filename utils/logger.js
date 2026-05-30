/**
 * Logging estructurado para el flujo Supervisor AI (pasos, tiempos, tamaños LLM, errores).
 */
const fs = require('fs');
const path = require('path');

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const CONFIG = {
  minLevel: LOG_LEVELS[(process.env.SUPERVISOR_LOG_LEVEL || 'info').toLowerCase()] ?? LOG_LEVELS.info,
  toFile: process.env.SUPERVISOR_LOG_TO_FILE === 'true' || process.env.SUPERVISOR_LOG_TO_FILE === '1',
  logDir: process.env.SUPERVISOR_LOG_DIR || path.join(process.cwd(), 'logs'),
  maxRuns: Math.max(5, parseInt(process.env.SUPERVISOR_LOG_MAX_RUNS || '30', 10)),
  llmWarnChars: parseInt(process.env.SUPERVISOR_LLM_WARN_CHARS || '80000', 10),
  llmErrorChars: parseInt(process.env.SUPERVISOR_LLM_ERROR_CHARS || '120000', 10)
};

/** @type {Map<string, object>} */
const runs = new Map();

function nowIso() {
  return new Date().toISOString();
}

function estimateTokensFromChars(charCount) {
  return Math.ceil(charCount / 4);
}

function safeJsonSize(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return -1;
  }
}

function appendToLogFile(line) {
  if (!CONFIG.toFile) return;
  try {
    if (!fs.existsSync(CONFIG.logDir)) {
      fs.mkdirSync(CONFIG.logDir, { recursive: true });
    }
    const date = new Date().toISOString().slice(0, 10);
    const filePath = path.join(CONFIG.logDir, `supervisor-${date}.log`);
    fs.appendFileSync(filePath, line + '\n', 'utf8');
  } catch (err) {
    console.error('[logger] No se pudo escribir log:', err.message);
  }
}

function formatConsoleLine(entry) {
  const meta = entry.data && Object.keys(entry.data).length
    ? ' ' + JSON.stringify(entry.data)
    : '';
  return `[${entry.ts}] [${entry.level.toUpperCase()}] [${entry.run_id}] ${entry.step}${meta}`;
}

function createRunId() {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function pruneRuns() {
  if (runs.size <= CONFIG.maxRuns) return;
  const sorted = [...runs.entries()].sort(
    (a, b) => new Date(a[1].started_at).getTime() - new Date(b[1].started_at).getTime()
  );
  const remove = sorted.length - CONFIG.maxRuns;
  for (let i = 0; i < remove; i++) {
    runs.delete(sorted[i][0]);
  }
}

/**
 * @param {object} meta
 * @returns {object} logger
 */
function createSupervisorRunLogger(meta = {}) {
  const runId = createRunId();
  const startedAt = Date.now();
  const events = [];
  let currentStep = null;
  let stepStartedAt = null;

  const run = {
    run_id: runId,
    started_at: nowIso(),
    finished_at: null,
    status: 'running',
    meta,
    current_step: null,
    events: [],
    summary: {}
  };
  runs.set(runId, run);

  function emit(level, step, data = {}) {
    if (LOG_LEVELS[level] < CONFIG.minLevel) return;
    const entry = {
      ts: nowIso(),
      level,
      run_id: runId,
      step,
      elapsed_ms: Date.now() - startedAt,
      data
    };
    events.push(entry);
    run.events.push(entry);
    run.current_step = currentStep || step;

    const line = formatConsoleLine(entry);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);

    appendToLogFile(line);
  }

  const logger = {
    runId,
    meta,

    debug(step, data) {
      emit('debug', step, data);
    },
    info(step, data) {
      emit('info', step, data);
    },
    warn(step, data) {
      emit('warn', step, data);
    },
    error(step, data) {
      emit('error', step, data);
    },

    stepStart(step, data = {}) {
      currentStep = step;
      stepStartedAt = Date.now();
      run.current_step = step;
      emit('info', `${step}_start`, data);
    },

    stepEnd(step, data = {}) {
      const ms = stepStartedAt != null ? Date.now() - stepStartedAt : null;
      emit('info', `${step}_done`, { ...data, duration_ms: ms });
      if (currentStep === step) {
        currentStep = null;
        stepStartedAt = null;
      }
    },

    logLlmPayload(label, payloadObject) {
      const chars = safeJsonSize(payloadObject);
      const estimated_tokens = estimateTokensFromChars(chars);
      const payload = {
        label,
        payload_chars: chars,
        estimated_tokens,
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini'
      };
      if (chars >= CONFIG.llmErrorChars) {
        emit('error', 'llm_payload_too_large', payload);
      } else if (chars >= CONFIG.llmWarnChars) {
        emit('warn', 'llm_payload_large', payload);
      } else {
        emit('debug', 'llm_payload_size', payload);
      }
      return payload;
    },

    setSummary(partial) {
      Object.assign(run.summary, partial);
    },

    finish(status = 'completed', extra = {}) {
      run.status = status;
      run.finished_at = nowIso();
      run.duration_ms = Date.now() - startedAt;
      run.current_step = null;
      Object.assign(run.summary, extra);
      emit(status === 'failed' ? 'error' : 'info', 'run_finished', {
        status,
        duration_ms: run.duration_ms,
        ...run.summary
      });
      pruneRuns();
    },

    toJSON() {
      return {
        run_id: runId,
        started_at: run.started_at,
        finished_at: run.finished_at,
        duration_ms: run.duration_ms ?? Date.now() - startedAt,
        status: run.status,
        meta: run.meta,
        current_step: run.current_step,
        summary: run.summary,
        events
      };
    }
  };

  logger.info('run_started', { meta });
  return logger;
}

function getRun(runId) {
  return runs.get(runId) || null;
}

function listRuns(limit = 20) {
  return [...runs.values()]
    .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
    .slice(0, limit)
    .map(run => ({
      run_id: run.run_id,
      started_at: run.started_at,
      finished_at: run.finished_at,
      status: run.status,
      duration_ms: run.duration_ms,
      current_step: run.current_step,
      meta: run.meta,
      summary: run.summary,
      event_count: run.events.length
    }));
}

module.exports = {
  createSupervisorRunLogger,
  getRun,
  listRuns,
  estimateTokensFromChars,
  safeJsonSize,
  CONFIG
};
