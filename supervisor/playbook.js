/**
 * Constitución del supervisor Ontime (playbook v1 / v2 cliente).
 */
const fs = require('fs');
const path = require('path');
const { loadSettings } = require('./settings.service');
const {
  getAiAgentSenderName,
  getArchitectSenderNames,
  getPlaybookVersion,
  ALL_QUOTE_DOMAINS
} = require('./constants');

const PROMPTS_DIR = path.join(__dirname, 'prompts');

function loadPlaybookMarkdown(version) {
  const file = path.join(PROMPTS_DIR, `supervisor-ontime-${version}.md`);
  if (fs.existsSync(file)) {
    return fs.readFileSync(file, 'utf8').trim();
  }
  return null;
}

function buildAgentWorkflow() {
  const settings = loadSettings();
  const aiAgent = getAiAgentSenderName();
  const architects = getArchitectSenderNames();
  const extra = settings.agent_workflow_extra?.trim();

  const base = `
Flujo obligatorio con herramientas (en este orden):
1. get_previous_report — historial en Supabase
2. get_recent_messages — mensajes Chatwoot de la ventana de actividad
3. get_snapshot_history — seguimiento día a día (opcional si ya hay datos en paso 4)
4. compute_business_facts — métricas, cotización por URL (hecho), inactividad, enrichment
5. submit_supervision_analysis — JSON final del análisis (única forma de terminar)

Reglas técnicas:
- NO resumir la conversación; evalúa desempeño comercial (playbook v2).
- Alcance: solo evaluation_stage lead o asesor_venta; si no, fuera_de_alcance.
- No inventes cotización: si compute_business_facts indica cotizacion_enviada=true, reflejarlo.
- Solo proyectos completos: si el arquitecto/asesor indica que no trabajan obra a medias o que solo hacen proyectos completos, es política de la empresa — NO catalogar como mala atención ni bajar score por eso.
- Separa AI Agent ("${aiAgent}") y arquitectos: ${architects.join(', ')}.
- Dominios oficiales de cotización: ${ALL_QUOTE_DOMAINS.join(', ')}.
- No respondas al cliente; solo supervisas calidad comercial interna.
`.trim();

  return extra ? `${base}\n\n${extra}` : base;
}

function getPlaybookSystemPrompt() {
  const version = getPlaybookVersion();
  const clientBody = loadPlaybookMarkdown(version);
  if (clientBody) {
    return `${clientBody}\n\n---\n\n${buildAgentWorkflow()}`;
  }

  return [
    'Eres el Supervisor de Calidad Comercial de On Time Cocinas (México).',
    `Playbook: ${version}.`,
    'Analizas conversaciones de Chatwoot con histórico en Supabase, snapshots y mensajes recientes.',
    buildAgentWorkflow()
  ].join(' ');
}

function getSupervisorSystemPrompt() {
  const settings = loadSettings();
  if (settings.use_custom_system_prompt && settings.system_prompt.trim()) {
    const extra = settings.system_prompt_extra?.trim();
    return extra ? `${settings.system_prompt.trim()}\n\n${extra}` : settings.system_prompt.trim();
  }

  const parts = [getPlaybookSystemPrompt()];
  const extra = settings.system_prompt_extra?.trim();
  if (extra) parts.push(extra);

  return parts.join('\n\n');
}

function getAnalysisJsonSchemaPrompt() {
  const aiAgent = getAiAgentSenderName();
  const architects = getArchitectSenderNames();
  const isV2 = getPlaybookVersion() === 'v2';

  if (isV2) {
    return `Devuelve SOLO JSON válido con esta estructura (playbook v2 — NO resumir conversación):
{
  "evaluation_scope": "en_alcance|fuera_de_alcance",
  "evaluation_stage": "lead|asesor_venta|fuera_de_alcance",
  "detected_funnel_stage": "lead|asesor_venta|cotizacion_enviada|contrato|diseno|instalacion|entrega|posventa|garantia|cobranza|indefinida",
  "out_of_scope_reason": "texto si fuera_de_alcance, si no vacío",
  "stage": "lead|asesor_venta|fuera_de_alcance|indefinida",
  "risk_level": "bajo|medio|alto|grave",
  "score_general": null,
  "score_comercial_label": "puntuacion|no_aplica",
  "customer_sentiment": "positivo|neutral|molesto|grave",
  "alerts": ["texto corto"],
  "strengths": ["texto corto"],
  "improvement_opportunities": ["texto corto"],
  "differentiators_detected": ["Entrega en 15 días", "Garantía de 5 años"],
  "venta_pasiva_detectada": false,
  "castigos_aplicados": ["texto del tope o regla aplicada"],
  "missed_followups": false,
  "abandoned_chat": false,
  "requires_human_review": false,
  "summary": "evaluación comercial breve — NO resumen de chat",
  "recommendation": "siguiente acción para el equipo (vacío si fuera_de_alcance)",
  "cerrar_evaluation": {
    "c_capto_intencion": 0,
    "e_entendio_necesidad": 0,
    "r_respondio_direccion": 0,
    "r_reforzo_valor": 0,
    "a_ataco_objeciones": 0,
    "r_reto_siguiente_paso": 0,
    "notas": "qué aplicó en lead vs asesor_venta"
  },
  "lead_checklist": {
    "que_pidio_cliente": "texto",
    "respondio_duda_directa": true,
    "pidio_datos_utiles": true,
    "comunico_beneficios": true,
    "escalo_humano_si_interes": true,
    "cliente_dejo_de_contestar": false,
    "motivo_silencio": "texto o vacío"
  },
  "ai_agent_analysis": {
    "present": false,
    "score": 0,
    "summary": "evaluación AI agent — no resumen",
    "strengths": ["texto"],
    "issues": ["texto"],
    "recommendation": "mejora"
  },
  "architect_analysis": {
    "present": false,
    "architect_names": ["nombre"],
    "score": 0,
    "summary": "evaluación arquitecto",
    "strengths": ["texto"],
    "issues": ["texto"],
    "recommendation": "mejora"
  },
  "handoff_analysis": {
    "quality": "no_aplica|buena|regular|mala",
    "summary": "traspaso bot → humano"
  },
  "sales_process_analysis": {
    "funnel_stage": "lead|asesor_venta|cotizacion_enviada|contrato|diseno|posventa|indefinida",
    "cotizacion_enviada": false,
    "cotizacion_evidence": "cita breve",
    "esperando_respuesta_cliente": false,
    "seguimiento_comercial": "adecuado|insuficiente|ausente|no_aplica",
    "seguimiento_resumen": "breve",
    "atencion_calidad": "excelente|buena|regular|mala",
    "atencion_resumen": "breve",
    "cambios_desde_ultimo_analisis": "breve",
    "proceso_venta_resumen": "evaluación comercial breve — NO narrativa larga",
    "proximo_paso_comercial": "acción concreta"
  }
}
Reglas v2:
- evaluation_scope=fuera_de_alcance → score_general=null, score_comercial_label=no_aplica, recommendation breve o vacía, sin CERRAR largo.
- evaluation_scope=en_alcance → evaluation_stage debe ser lead o asesor_venta; score_general entero 0-100; aplicar castigos del playbook.
- stage debe igualar evaluation_stage.
- Si cotización URL oficial (enrichment), detected_funnel_stage mínimo cotizacion_enviada y evaluar como asesor_venta salvo posventa/garantía/instalación.
- Usuario "${aiAgent}" = AI Agent. Arquitectos: ${architects.join(', ')}. Otros salientes = asesor_no_catalogado.
- Política proyectos completos: explicar "solo trabajamos en proyectos completos" / "no obra a medias" es correcto; no marcar architect_analysis.issues ni atencion_calidad mala/regular solo por declinar trabajo parcial; risk_level=bajo (no medio) salvo situación grave explícita.
- risk_level grave: amenaza legal, Profeco, redes, cliente pagó sin atención, múltiples insistencias sin respuesta.
- Dominios cotización: ${ALL_QUOTE_DOMAINS.join(', ')}.
- No inventar hechos.`;
  }

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
  "ai_agent_analysis": { "present": false, "score": 0, "summary": "", "strengths": [], "issues": [], "recommendation": "" },
  "architect_analysis": { "present": false, "architect_names": [], "score": 0, "summary": "", "strengths": [], "issues": [], "recommendation": "" },
  "handoff_analysis": { "quality": "no_aplica|buena|regular|mala", "summary": "" },
  "sales_process_analysis": {
    "funnel_stage": "lead|calificacion|asesor_ventas|cotizacion_enviada|negociacion|cierre|posventa|indefinida",
    "cotizacion_enviada": false,
    "cotizacion_evidence": "",
    "esperando_respuesta_cliente": false,
    "seguimiento_comercial": "adecuado|insuficiente|ausente|no_aplica",
    "seguimiento_resumen": "",
    "atencion_calidad": "excelente|buena|regular|mala",
    "atencion_resumen": "",
    "cambios_desde_ultimo_analisis": "",
    "proceso_venta_resumen": "",
    "proximo_paso_comercial": ""
  }
}
Reglas:
- score_general entero 0-100.
- AI Agent: "${aiAgent}". Arquitectos: ${architects.join(', ')}.
- Si enrichment.quote_detection.cotizacion_enviada es true, cotización YA enviada.
- Dominios: ${ALL_QUOTE_DOMAINS.join(', ')}.`;
}

function getSubmitToolDescription() {
  return `Envía el análisis final de supervisión (evaluación comercial, no resumen). Esquema:\n${getAnalysisJsonSchemaPrompt()}`;
}

module.exports = {
  getPlaybookVersion,
  buildAgentWorkflow,
  getPlaybookSystemPrompt,
  getSupervisorSystemPrompt,
  getAnalysisJsonSchemaPrompt,
  getSubmitToolDescription,
  loadPlaybookMarkdown
};
