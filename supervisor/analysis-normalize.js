/**
 * Normaliza y valida el JSON de submit_supervision_analysis (playbook v2).
 */
const { getPlaybookVersion } = require('./playbook');

function normalizeSupervisionAnalysis(analysis) {
  if (!analysis || typeof analysis !== 'object') {
    throw new Error('submit_supervision_analysis: objeto analysis requerido.');
  }

  const next = { ...analysis };
  const version = getPlaybookVersion();

  if (version !== 'v2') {
    return validateLegacyAnalysis(next);
  }

  next.evaluation_stage = String(next.evaluation_stage || next.stage || 'indefinida').trim();
  next.evaluation_scope =
    next.evaluation_scope ||
    (next.evaluation_stage === 'fuera_de_alcance' ? 'fuera_de_alcance' : 'en_alcance');
  next.stage = next.evaluation_stage;

  if (next.evaluation_scope === 'fuera_de_alcance' || next.evaluation_stage === 'fuera_de_alcance') {
    next.evaluation_scope = 'fuera_de_alcance';
    next.evaluation_stage = 'fuera_de_alcance';
    next.stage = 'fuera_de_alcance';
    next.score_comercial_label = 'no_aplica';
    next.score_general = null;
    if (!next.summary || !String(next.summary).trim()) {
      throw new Error('fuera_de_alcance: summary breve obligatorio.');
    }
    if (!next.risk_level) next.risk_level = 'bajo';
    return next;
  }

  if (!['lead', 'asesor_venta'].includes(next.evaluation_stage)) {
    throw new Error(
      'evaluation_stage debe ser lead o asesor_venta cuando evaluation_scope=en_alcance.'
    );
  }

  if (!next.summary || !String(next.summary).trim()) {
    throw new Error('submit_supervision_analysis: falta summary (evaluación comercial).');
  }
  if (!next.risk_level) {
    throw new Error('submit_supervision_analysis: falta risk_level.');
  }

  const score = next.score_general;
  if (score === null || score === undefined || score === '') {
    throw new Error('en_alcance: score_general obligatorio (0-100).');
  }
  const num = Number(score);
  if (!Number.isFinite(num) || num < 0 || num > 100) {
    throw new Error('score_general debe ser entero 0-100 en alcance.');
  }
  next.score_general = Math.round(num);
  next.score_comercial_label = 'puntuacion';
  next.stage = next.evaluation_stage;

  return next;
}

function validateLegacyAnalysis(analysis) {
  const required = ['stage', 'risk_level', 'summary'];
  for (const key of required) {
    if (!analysis[key]) {
      throw new Error(`submit_supervision_analysis: falta campo "${key}".`);
    }
  }
  const score = Number(analysis.score_general);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new Error('submit_supervision_analysis: score_general debe ser entero 0-100.');
  }
  return analysis;
}

module.exports = {
  normalizeSupervisionAnalysis
};
