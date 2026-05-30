let allRows = [];
let filteredRows = [];
let conversationIds = [];
let currentPage = 1;
const PAGE_SIZE = 25;
const BRANCH_NAME_BY_ID = {
  '49': 'HmoOntime',
  '48': 'nogontime',
  '51': 'cenontime',
  '52': 'FB Hermosillo OTC'
};

const RISK_ORDER = ['grave', 'alto', 'medio', 'bajo'];
let reportsTabRaw = [];
let followupItemsRaw = [];

const FOLLOWUP_STATUS_ORDER = [
  'sin_sincronizar',
  'cliente_sin_respuesta',
  'sin_seguimiento_hoy',
  'seguimiento_ok_hoy'
];

const FOLLOWUP_STATUS_LABELS = {
  seguimiento_ok_hoy: 'Seguimiento OK hoy',
  sin_seguimiento_hoy: 'Sin seguimiento humano hoy',
  cliente_sin_respuesta: 'Cliente sin respuesta',
  sin_sincronizar: 'Sin sincronizar hoy'
};

/** Nombre del agente (Chatwoot) cuyos últimos mensajes salientes no se muestran en el dashboard. */
const OUTBOUND_SENDER_EXCLUDE = 'Super Admin';

function outboundSenderDisplayName(message) {
  const s = message?.sender;
  if (!s || typeof s !== 'object') return '';
  return String(s.available_name || s.name || s.email || '').trim();
}

function isExcludedOutboundSender(displayName) {
  if (displayName == null || String(displayName).trim() === '') return false;
  return String(displayName).trim().toLowerCase() === OUTBOUND_SENDER_EXCLUDE.toLowerCase();
}

/** URL al panel web de Chatwoot para una conversación (misma cuenta / inbox / conv). */
function buildConversationAppUrl(baseUrl, accountId, inboxId, conversationId) {
  const root = String(baseUrl || '').trim().replace(/\/$/, '');
  const acc = String(accountId ?? '').trim();
  const inbox = String(inboxId ?? '').trim();
  const conv = String(conversationId ?? '').trim();
  if (!root || !acc || !inbox || !conv) return '';
  return `${root}/app/accounts/${acc}/inbox/${inbox}/conversations/${conv}`;
}

function escAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getSelectedBranch() {
  const branchSelect = document.getElementById('cw-branch');
  const branchId = branchSelect?.value?.trim() || '49';
  const branchName = BRANCH_NAME_BY_ID[branchId] || BRANCH_NAME_BY_ID['49'];
  return {
    id: branchId,
    name: branchName
  };
}

/** Si el campo proxy está vacío y la página va por http(s), usar el mismo origen (útil en Docker). */
function resolveProxyUrlInput(raw) {
  const trimmed = (raw || '').trim().replace(/\/$/, '');
  if (trimmed) return trimmed;
  if (typeof window !== 'undefined' && window.location) {
    const p = window.location.protocol;
    if (p === 'http:' || p === 'https:') {
      return window.location.origin.replace(/\/$/, '');
    }
  }
  return '';
}

function showStatus(msg) {
  document.getElementById('status-bar').classList.add('active');
  document.getElementById('status-text').textContent = msg;
}

function hideStatus() {
  document.getElementById('status-bar').classList.remove('active');
}

function showError(msg) {
  const el = document.getElementById('error-box');
  el.textContent = '⚠ ' + msg;
  el.classList.add('show');
}

function hideError() {
  document.getElementById('error-box').classList.remove('show');
}

function clearResults() {
  document.getElementById('results').classList.add('results-hidden');
  document.getElementById('ids-count').textContent = '0 IDs';
  document.getElementById('ids-list').textContent = 'Sin datos';
  conversationIds = [];
  allRows = [];
  filteredRows = [];
  hideError();
  hideStatus();
}

/** Mensaje más útil cuando fetch() ni siquiera recibe respuesta (CORS, proxy caído, file://, etc.). */
function explainFetchFailure(err, { proxyUrl, baseUrl }) {
  const msg = err && err.message ? err.message : String(err);
  const isNetworkFail =
    msg === 'Failed to fetch' ||
    /network\s*error|load failed|aborted|failed to load/i.test(msg);
  if (!isNetworkFail) return msg;

  const usingProxy = Boolean(proxyUrl);
  const loc = typeof window !== 'undefined' ? window.location : null;
  const origin = loc ? `${loc.protocol}//${loc.host}` : '';
  const mixed =
    loc &&
    loc.protocol === 'https:' &&
    proxyUrl &&
    String(proxyUrl).startsWith('http:');
  const pagePort = loc && loc.port ? loc.port : (loc && loc.protocol === 'https:' ? '443' : loc && loc.protocol === 'http:' ? '80' : '');
  const proxyLooksLocal3001 =
    proxyUrl && /^(https?:)\/\/(127\.0\.0\.1|localhost):3001\b/i.test(String(proxyUrl).trim());
  const dockerPortMismatch =
    proxyLooksLocal3001 && pagePort && pagePort !== '3001';
  const parts = [
    'No hubo respuesta del servidor (red o bloqueo del navegador).',
    mixed
      ? 'Posible contenido mixto: la página es HTTPS pero el proxy es HTTP; el navegador suele bloquear esa petición. Abre el dashboard por http:// o sirve el proxy también por https.'
      : '',
    dockerPortMismatch
      ? `La app está en el puerto ${pagePort} pero «Proxy local» apunta al 3001 del host: ahí no hay servicio (ERR_CONNECTION_REFUSED). Deja «Proxy local» vacío para usar el mismo origen, o reinicia Docker con el mapeo 3001:3001 en compose.`
      : '',
    usingProxy
      ? `Proxy usado: ${proxyUrl}/chatwoot/…`
      : 'No hay proxy: las peticiones van directo a Chatwoot (suele fallar por CORS salvo configuración especial).',
    origin ? `Origen de esta página: ${origin}` : '',
    'Comprueba: ① `node proxy-server.js` o Docker en marcha; ② entra con http://127.0.0.1:PUERTO/ (no abras index.html como archivo file://); ③ campo «Proxy local» vacío solo si la URL del navegador es la del mismo servidor; si no, pon http://127.0.0.1:3001.',
    baseUrl ? `URL Chatwoot configurada: ${baseUrl}` : ''
  ].filter(Boolean);
  return parts.join(' ');
}

async function fetchData() {
  hideError();

  if (typeof window !== 'undefined' && window.location.protocol === 'file:') {
    showError(
      'Estás abriendo la app como archivo (file://). El navegador bloquea estas peticiones. Ejecuta `node proxy-server.js` y abre http://127.0.0.1:3001/ (o tu puerto Docker). Opcional: en «Proxy local» pon http://127.0.0.1:3001 aunque abras el HTML desde disco (a veces sigue fallando; preferible usar http).'
    );
    return;
  }

  const baseUrl = document.getElementById('cw-url').value.trim().replace(/\/$/, '');
  const token = document.getElementById('cw-token').value.trim();
  const accountId = document.getElementById('cw-account').value.trim();
  const limit = parseInt(document.getElementById('cw-limit').value, 10);
  const selectedBranch = getSelectedBranch();
  const proxyUrl = resolveProxyUrlInput(document.getElementById('proxy-url').value);

  if (!baseUrl || !token || !accountId) {
    showError('Por favor completa todos los campos: URL, Token y Account ID.');
    return;
  }

  document.getElementById('btn-fetch').disabled = true;
  document.getElementById('results').classList.add('results-hidden');
  allRows = [];

  const requestContext = { baseUrl, proxyUrl, token };

  try {
    const contactMap = {};
    const conversations = await fetchConversationList(requestContext, accountId, limit, selectedBranch);
    conversationIds = conversations.map(c => c.id).filter(Boolean);

    if (!conversationIds.length) {
      throw new Error('No se obtuvieron IDs de conversaciones con ese filtro.');
    }

    renderConversationIds();
    console.log('IDs de conversaciones obtenidos:', conversationIds);

    for (let i = 0; i < conversations.length; i++) {
      const conv = conversations[i];
      const contact = conv.meta?.sender || conv.contact || {};
      const contactId = contact.id;
      if (!contactId) continue;

      const inboxName = conv.inbox_id ? (conv.meta?.channel || `Inbox ${conv.inbox_id}`) : '—';
      const convStatus = conv.status || 'unknown';

      showStatus(`Analizando conv. #${conv.id} (${i + 1}/${conversations.length})`);

      let lastOutboundAt = null;
      let lastOutboundContent = '—';
      let lastOutboundSenderName = '';

      try {
        const msgPath = buildMessagesPath(accountId, conv.id);
        const msgRes = await chatwootFetch(requestContext, msgPath);
        if (msgRes.ok) {
          const msgData = await msgRes.json();
          const messages = msgData?.payload || [];
          const outbounds = messages.filter(m => m.message_type === 1 && !m.private);
          if (outbounds.length) {
            outbounds.sort((a, b) => b.created_at - a.created_at);
            const latest = outbounds[0];
            lastOutboundAt = latest.created_at * 1000;
            lastOutboundContent = latest.content || '[adjunto]';
            lastOutboundSenderName = outboundSenderDisplayName(latest);
          }
        }
      } catch (e) {
        // Ignorar errores de una conversación particular para continuar con el resto.
      }

      if (!lastOutboundAt) continue;

      const existing = contactMap[contactId];
      if (!existing || lastOutboundAt > existing.lastOutboundAt) {
        const inboxIdForUrl = conv.inbox_id != null ? conv.inbox_id : selectedBranch.id;
        contactMap[contactId] = {
          id: contactId,
          name: contact.name || `Contacto ${contactId}`,
          email: contact.email || '—',
          phone: contact.phone_number || '—',
          lastOutboundAt,
          lastOutboundContent,
          lastOutboundSenderName,
          inbox: inboxName,
          status: convStatus,
          convId: conv.id,
          conversationUrl: buildConversationAppUrl(baseUrl, accountId, inboxIdForUrl, conv.id)
        };
      }
    }

    allRows = Object.values(contactMap).filter(
      r => !isExcludedOutboundSender(r.lastOutboundSenderName)
    );
    if (!allRows.length) {
      showError('No se encontraron mensajes salientes en las conversaciones analizadas.');
      document.getElementById('btn-fetch').disabled = false;
      hideStatus();
      return;
    }

    renderStats();
    applyFilters();
    document.getElementById('results').classList.remove('results-hidden');
    hideStatus();
    document.getElementById('btn-fetch').disabled = false;
  } catch (err) {
    hideStatus();
    document.getElementById('btn-fetch').disabled = false;
    const detail = explainFetchFailure(err, { proxyUrl: requestContext.proxyUrl, baseUrl });
    showError('Error al conectar con Chatwoot: ' + detail);
    console.error(err);
  }
}

function supervisorPayload() {
  const fieldValue = id => document.getElementById(id)?.value?.trim() || '';
  const baseUrl = fieldValue('cw-url').replace(/\/$/, '');
  const token = fieldValue('cw-token');
  const accountId = fieldValue('cw-account');
  const selectedBranch = getSelectedBranch();
  return {
    baseUrl,
    token,
    accountId,
    inboxId: selectedBranch.id,
    branchName: selectedBranch.name,
    limit: 0
  };
}

async function apiFetch(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  const fetchFn = window.OntimeAuth?.authFetch || fetch;
  const response = await fetchFn(path, { ...options, headers });

  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && window.OntimeAuth) {
    await window.OntimeAuth.signOut();
    throw new Error(data.error || 'Sesión expirada.');
  }
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function supervisorApi(path, options = {}) {
  return apiFetch(path, options);
}

async function runSupervisorAnalysis() {
  hideError();
  const payload = supervisorPayload();

  const btn = document.getElementById('btn-ai-analyze');
  btn.disabled = true;
  const branchLabel = payload.branchName || `inbox ${payload.inboxId}`;
  showStatus(`Analizando conversaciones con actividad en las últimas 24h (${branchLabel})...`);

  try {
    const data = await supervisorApi('/api/supervisor/analyze', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    const snapInfo = data.snapshot_count
      ? ` · Snapshots hoy: ${data.snapshot_count}`
      : '';
    const taggedInfo =
      data.tagged_inactive_interest != null
        ? ` · Etiquetadas +${data.inactive_days_threshold || 2}d inactivas con interés: ${data.tagged_inactive_interest}`
        : '';
    renderSupervisorDebugLog(data.debug, data.run_id);
    renderSupervisorReports(
      data.reports || [],
      `AI analizó ${data.analyzed}/${data.fetched} conversaciones con actividad en ${data.activity_window_hours || 24}h (mensajes recientes de Chatwoot + historial en BD). Guardado: ${data.stored ? 'sí' : 'no'}${taggedInfo}${snapInfo}${data.errors?.length ? ` · Errores: ${data.errors.length}` : ''}${data.run_id ? ` · Log: ${data.run_id}` : ''}`
    );
    const reportsBranch = document.getElementById('reports-branch');
    if (reportsBranch) reportsBranch.value = payload.inboxId;
    goToReportsTab();
  } catch (err) {
    showError('Error en Supervisor AI: ' + err.message);
    console.error(err);
  } finally {
    btn.disabled = false;
    hideStatus();
  }
}

function switchAppTab(tabId) {
  const panels = {
    supervisor: 'tab-supervisor',
    reportes: 'tab-reportes',
    seguimiento: 'tab-seguimiento'
  };
  const buttons = {
    supervisor: 'tab-btn-supervisor',
    reportes: 'tab-btn-reportes',
    seguimiento: 'tab-btn-seguimiento'
  };
  for (const key of Object.keys(panels)) {
    const panel = document.getElementById(panels[key]);
    const btn = document.getElementById(buttons[key]);
    const active = key === tabId;
    if (panel) {
      panel.classList.toggle('active', active);
      if (active) panel.removeAttribute('hidden');
      else panel.setAttribute('hidden', '');
    }
    if (btn) {
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    }
  }
  if (tabId === 'reportes') loadReportsTab();
  if (tabId === 'seguimiento') loadFollowupTab();
}

function goToFollowupTab() {
  const cwBranch = document.getElementById('cw-branch')?.value?.trim();
  const followupBranch = document.getElementById('followup-branch');
  if (cwBranch && followupBranch) followupBranch.value = cwBranch;
  switchAppTab('seguimiento');
}

function goToReportsTab() {
  const cwBranch = document.getElementById('cw-branch')?.value?.trim();
  const reportsBranch = document.getElementById('reports-branch');
  if (cwBranch && reportsBranch) reportsBranch.value = cwBranch;
  switchAppTab('reportes');
}

function buildReportsQuery() {
  const params = new URLSearchParams();
  const limit = parseInt(document.getElementById('reports-limit')?.value || '100', 10);
  params.set('limit', String(Math.min(limit, 200)));

  const branchId = document.getElementById('reports-branch')?.value?.trim() || '';
  if (branchId) {
    params.set('inbox_id', branchId);
    const branchName = BRANCH_NAME_BY_ID[branchId];
    if (branchName) params.set('branch', branchName);
  }

  const risk = document.getElementById('reports-risk')?.value?.trim() || '';
  if (risk) params.set('risk_level', risk);

  return params.toString();
}

function filterReportsBySearch(reports) {
  const q = (document.getElementById('reports-search')?.value || '').trim().toLowerCase();
  if (!q) return reports;
  return reports.filter(report => {
    const haystack = [
      report.contact_name,
      report.contact_phone,
      report.contact_email,
      report.conversation_id,
      report.branch_name,
      report.summary,
      report.ai_agent_summary,
      report.risk_level
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

function branchInfoForReport(report) {
  const id = report.inbox_id != null ? String(report.inbox_id) : '';
  const name = report.branch_name || BRANCH_NAME_BY_ID[id] || 'Sin sucursal';
  const key = id || name;
  const label = id ? `${name} (${id})` : name;
  return { key, label, name, id };
}

function normalizeRiskLevel(risk) {
  const key = String(risk || 'medio').toLowerCase();
  return RISK_ORDER.includes(key) ? key : 'medio';
}

function groupReportsByBranchAndRisk(reports) {
  const tree = new Map();
  for (const report of reports) {
    const branch = branchInfoForReport(report);
    if (!tree.has(branch.key)) {
      tree.set(branch.key, { label: branch.label, risks: new Map() });
    }
    const block = tree.get(branch.key);
    const risk = normalizeRiskLevel(report.risk_level);
    if (!block.risks.has(risk)) block.risks.set(risk, []);
    block.risks.get(risk).push(report);
  }

  return [...tree.entries()]
    .map(([key, data]) => ({
      key,
      label: data.label,
      risks: RISK_ORDER.filter(r => data.risks.has(r)).map(r => ({
        risk: r,
        reports: data.risks.get(r)
      }))
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'es'));
}

function renderReportsSummary(reports, grouped) {
  const el = document.getElementById('reports-summary');
  if (!el) return;
  const byRisk = {};
  for (const r of reports) {
    const risk = normalizeRiskLevel(r.risk_level);
    byRisk[risk] = (byRisk[risk] || 0) + 1;
  }
  const chips = [
    `<span class="reports-chip">${reports.length} reporte(s)</span>`,
    `<span class="reports-chip">${grouped.length} sucursal(es)</span>`
  ];
  for (const risk of RISK_ORDER) {
    if (byRisk[risk]) chips.push(`<span class="reports-chip">${risk}: ${byRisk[risk]}</span>`);
  }
  el.innerHTML = chips.join('');
}

function renderReportCard(report) {
  const title = report.contact_name || `Conversación ${report.conversation_id}`;
  const score = report.score_general == null ? '—' : String(report.score_general);
  const architectNames = asList(report.architect_names).join(', ') || 'sin nombre identificado';
  const aiAgentBlock = participantSection(
    'AI Agent',
    report.ai_agent_present,
    report.ai_agent_score,
    report.ai_agent_summary,
    report.ai_agent_issues,
    report.ai_agent_recommendation,
    `Mensajes salientes AI: ${report.ai_agent_outbound_count || 0}`
  );
  const architectBlock = participantSection(
    'Arquitecto',
    report.architect_present,
    report.architect_score,
    report.architect_summary,
    report.architect_issues,
    report.architect_recommendation,
    `Arquitecto(s): ${architectNames}`
  );
  const url = report.conversation_url
    ? `<a class="conv-link" href="${escAttr(report.conversation_url)}" target="_blank" rel="noopener noreferrer">Abrir conversación</a>`
    : '';
  const analyzed = report.analyzed_at
    ? new Date(report.analyzed_at).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })
    : '—';

  return `
    <div class="supervisor-card">
      <div class="supervisor-card-head">
        <div>
          <div class="supervisor-card-title">${escHtml(title)}</div>
          <div class="supervisor-card-meta">${escHtml(analyzed)} · ${escHtml(report.stage || 'indefinida')} · Score ${escHtml(score)}</div>
        </div>
        <div class="supervisor-card-badges">
          ${inactiveInterestBadge(report)}
          ${riskBadge(report.risk_level)}
        </div>
      </div>
      <div class="supervisor-card-body">
        <div>${escHtml(report.summary || 'Sin resumen.')}</div>
        ${salesProcessSection(report)}
        ${aiAgentBlock}
        ${architectBlock}
        <div><strong>Recomendación:</strong> ${escHtml(report.recommendation || '—')}</div>
        <div>${url}</div>
      </div>
    </div>
  `;
}

function renderReportsTab(reports) {
  const content = document.getElementById('reports-content');
  if (!content) return;

  const grouped = groupReportsByBranchAndRisk(reports);
  renderReportsSummary(reports, grouped);

  if (!reports.length) {
    const branchId = document.getElementById('reports-branch')?.value?.trim() || '';
    const risk = document.getElementById('reports-risk')?.value?.trim() || '';
    const branchLabel = branchId
      ? `${BRANCH_NAME_BY_ID[branchId] || 'Sucursal'} (${branchId})`
      : 'todas las sucursales';
    const riskLabel = risk ? `riesgo ${risk}` : 'todos los niveles de riesgo';
    content.innerHTML = `
      <div class="reports-empty">
        No hay reportes para <strong>${escHtml(branchLabel)}</strong> con <strong>${escHtml(riskLabel)}</strong>.
        <br>Ejecuta un análisis en la pestaña Supervisor AI o amplía la cantidad cargada.
      </div>
    `;
    return;
  }

  content.innerHTML = grouped.map(branch => `
    <div class="reports-branch-block">
      <div class="reports-branch-head">
        <div class="reports-branch-name">${escHtml(branch.label)}</div>
        <div class="reports-branch-count">${branch.risks.reduce((n, s) => n + s.reports.length, 0)} reporte(s)</div>
      </div>
      ${branch.risks.map(section => `
        <div class="reports-risk-section">
          <div class="reports-risk-head">
            <span class="reports-risk-title">Riesgo ${escHtml(section.risk)}</span>
            ${riskBadge(section.risk)}
            <span class="reports-branch-count">${section.reports.length}</span>
          </div>
          <div class="reports-grid">
            ${section.reports.map(r => renderReportCard(r)).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `).join('');
}

function applyReportsSearch() {
  const filtered = filterReportsBySearch(reportsTabRaw);
  renderReportsTab(filtered);
}

async function loadReportsTab() {
  hideError();
  showStatus('Cargando reportes...');

  try {
    const query = buildReportsQuery();
    const data = await supervisorApi(`/api/supervisor/reports?${query}`);
    reportsTabRaw = data.reports || [];
    applyReportsSearch();
  } catch (err) {
    showError('Error al cargar reportes: ' + err.message);
    console.error(err);
  } finally {
    hideStatus();
  }
}

/** @deprecated */
async function loadSupervisorReports() {
  goToReportsTab();
}

function buildFollowupQuery() {
  const params = new URLSearchParams();
  const limit = parseInt(document.getElementById('followup-limit')?.value || '100', 10);
  params.set('limit', String(Math.min(limit, 200)));

  const branchId = document.getElementById('followup-branch')?.value?.trim() || '';
  if (branchId) params.set('inbox_id', branchId);

  const stages = document.getElementById('followup-stages')?.value?.trim() || 'asesor_ventas,cotizacion_pendiente';
  if (stages) params.set('stages', stages);

  return params.toString();
}

function followupStatusBadge(status) {
  const key = String(status || 'sin_sincronizar');
  const clsMap = {
    seguimiento_ok_hoy: 'followup-status-ok',
    sin_seguimiento_hoy: 'followup-status-bad',
    cliente_sin_respuesta: 'followup-status-warn',
    sin_sincronizar: 'followup-status-muted'
  };
  const cls = clsMap[key] || 'followup-status-muted';
  const label = FOLLOWUP_STATUS_LABELS[key] || key;
  return `<span class="badge ${cls}">${escHtml(label)}</span>`;
}

function formatFollowupTimestamp(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return String(iso);
  }
}

function renderFollowupSummary(summary, meta) {
  const el = document.getElementById('followup-summary');
  if (!el || !summary) return;
  const chips = [
    `<span class="reports-chip">Fecha: ${escHtml(meta.snapshot_date || '—')} (${escHtml(meta.timezone || '')})</span>`,
    `<span class="reports-chip">Total: ${summary.total}</span>`,
    `<span class="reports-chip">OK hoy: ${summary.seguimiento_ok_hoy}</span>`,
    `<span class="reports-chip">Sin seguimiento: ${summary.sin_seguimiento_hoy}</span>`,
    `<span class="reports-chip">Cliente espera: ${summary.cliente_sin_respuesta}</span>`,
    `<span class="reports-chip">Sin sync: ${summary.sin_sincronizar}</span>`,
    `<span class="reports-chip">Actividad nueva vs ayer: ${summary.actividad_nueva}</span>`
  ];
  el.innerHTML = chips.join('');
}

function groupFollowupByStatus(items) {
  const groups = new Map();
  for (const status of FOLLOWUP_STATUS_ORDER) groups.set(status, []);
  for (const item of items) {
    const key = FOLLOWUP_STATUS_ORDER.includes(item.followup_status)
      ? item.followup_status
      : 'sin_seguimiento_hoy';
    groups.get(key).push(item);
  }
  return FOLLOWUP_STATUS_ORDER
    .filter(status => groups.get(status).length)
    .map(status => ({ status, items: groups.get(status) }));
}

function renderFollowupRow(item) {
  const title = item.contact_name || `Conv. ${item.conversation_id}`;
  const phone = item.contact_phone || '—';
  const changes = Array.isArray(item.changes) && item.changes.length
    ? `<div class="followup-changes">${escHtml(item.changes.join(' · '))}</div>`
    : '';
  const url = item.conversation_url
    ? `<a class="conv-link" href="${escAttr(item.conversation_url)}" target="_blank" rel="noopener noreferrer">Abrir</a>`
    : '—';
  const today = item.today_snapshot;
  const yesterday = item.yesterday_snapshot;
  const lastHuman = today?.last_human_outbound_at || yesterday?.last_human_outbound_at;

  return `
    <tr>
      <td>
        <strong>${escHtml(title)}</strong>
        <div class="followup-id">Conv. ${escHtml(String(item.conversation_id))} · ${escHtml(phone)}</div>
      </td>
      <td>${escHtml(item.branch_name || '—')}</td>
      <td>${escHtml(item.stage || '—')}</td>
      <td>${followupStatusBadge(item.followup_status)}</td>
      <td>${escHtml(item.vs_yesterday || '—')}</td>
      <td>${formatFollowupTimestamp(lastHuman)}</td>
      <td>${formatFollowupTimestamp(today?.last_inbound_at)}</td>
      <td>${url}${changes}</td>
    </tr>
  `;
}

function renderFollowupTab(payload) {
  const content = document.getElementById('followup-content');
  if (!content) return;

  const items = payload?.items || [];
  followupItemsRaw = items;
  renderFollowupSummary(payload?.summary, {
    snapshot_date: payload?.snapshot_date,
    timezone: payload?.timezone
  });

  if (!items.length) {
    content.innerHTML = `
      <div class="reports-empty">
        No hay conversaciones en las etapas seleccionadas con reportes previos en Supabase.
        <br>Primero ejecuta <strong>Analizar con AI</strong> en Supervisor y luego <strong>Sincronizar hoy</strong>.
      </div>
    `;
    return;
  }

  const grouped = groupFollowupByStatus(items);
  content.innerHTML = grouped.map(section => `
    <div class="followup-section">
      <div class="followup-section-head">
        ${followupStatusBadge(section.status)}
        <span class="reports-branch-count">${section.items.length} cliente(s)</span>
      </div>
      <div class="followup-table-wrap">
        <table class="followup-table">
          <thead>
            <tr>
              <th>Cliente</th>
              <th>Sucursal</th>
              <th>Etapa</th>
              <th>Estado hoy</th>
              <th>Vs ayer</th>
              <th>Último humano</th>
              <th>Último cliente</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            ${section.items.map(item => renderFollowupRow(item)).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `).join('');
}

async function loadFollowupTab() {
  hideError();
  showStatus('Cargando seguimiento diario...');

  try {
    const query = buildFollowupQuery();
    const data = await supervisorApi(`/api/supervisor/followup?${query}`);
    renderFollowupTab(data);
  } catch (err) {
    showError('Error al cargar seguimiento: ' + err.message);
    console.error(err);
  } finally {
    hideStatus();
  }
}

async function syncFollowupToday() {
  hideError();
  showStatus('Sincronizando snapshots desde Chatwoot...');

  try {
    const branchId = document.getElementById('followup-branch')?.value?.trim() || '';
    const stages = document.getElementById('followup-stages')?.value?.trim() || 'asesor_ventas,cotizacion_pendiente';
    const limit = parseInt(document.getElementById('followup-limit')?.value || '100', 10);
    const branchName = BRANCH_NAME_BY_ID[branchId] || '';

    const data = await supervisorApi('/api/supervisor/followup/sync', {
      method: 'POST',
      body: JSON.stringify({
        inboxId: branchId || undefined,
        branchName,
        stages,
        limit
      })
    });

    const errCount = data.errors?.length || 0;
    showStatus(
      `Sync ${data.snapshot_date}: ${data.synced}/${data.reports_matched} conversaciones` +
      (errCount ? ` · ${errCount} error(es)` : '')
    );
    setTimeout(hideStatus, 2500);
    await loadFollowupTab();
  } catch (err) {
    showError('Error al sincronizar: ' + err.message);
    console.error(err);
    hideStatus();
  }
}

function riskBadge(riskLevel) {
  const key = String(riskLevel || 'medio').toLowerCase();
  const cls = ['bajo', 'medio', 'alto', 'grave'].includes(key) ? `risk-${key}` : 'risk-medio';
  return `<span class="badge ${cls}">${escHtml(key)}</span>`;
}

function asList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function salesProcessFromReport(report) {
  const raw = report?.raw_analysis;
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw).sales_process_analysis || null;
    } catch {
      return null;
    }
  }
  return raw.sales_process_analysis || null;
}

function quoteDetectionFromReport(report) {
  return report?.metrics?.quote_detection ||
    report?.raw_analysis?.quote_detection ||
    null;
}

function salesProcessSection(report) {
  const sp = salesProcessFromReport(report);
  const qd = quoteDetectionFromReport(report);
  const urlConfirmed = qd?.cotizacion_enviada || sp?.cotizacion_detection_source === 'url_pattern';
  const cotizacionEnviada = urlConfirmed || Boolean(sp?.cotizacion_enviada);

  if (!sp && !qd) return '';

  const detectionBadge = urlConfirmed
    ? `<span class="badge followup-status-ok">Confirmado por URL</span>`
    : (cotizacionEnviada
      ? `<span class="badge followup-status-warn">Solo inferencia AI</span>`
      : `<span class="badge followup-status-muted">Sin URL oficial</span>`);

  const cotizacion = cotizacionEnviada
    ? `Sí · ${escHtml(qd?.cotizacion_domain || sp?.cotizacion_url_domain || '')} ${detectionBadge}`
    : `No detectada ${detectionBadge}`;
  const espera = sp?.esperando_respuesta_cliente ? 'Sí' : 'No';
  const newMsgs = report.metrics?.new_messages_at_analysis;
  const sentAt = qd?.cotizacion_sent_at
    ? formatFollowupTimestamp(qd.cotizacion_sent_at)
    : (sp?.cotizacion_sent_at ? formatFollowupTimestamp(sp.cotizacion_sent_at) : '—');

  return `
    <div class="supervisor-card-section sales-process-section">
      <div><strong>Proceso de venta</strong> · Embudo: ${escHtml(sp?.funnel_stage || '—')}</div>
      <div><strong>Cotización enviada:</strong> ${cotizacion}</div>
      <div class="supervisor-card-meta">Enviada (URL): ${escHtml(sentAt)} · Por: ${escHtml(qd?.cotizacion_sent_by || '—')}${qd && !qd.matches_branch_expected && qd.expected_region ? ` · Región enlace: ${escHtml(qd.cotizacion_region)} (esperada: ${escHtml(qd.expected_region)})` : ''}</div>
      <div><strong>Esperando al cliente:</strong> ${escHtml(espera)} · <strong>Seguimiento:</strong> ${escHtml(sp?.seguimiento_comercial || '—')}</div>
      <div><strong>Atención (${escHtml(sp?.atencion_calidad || '—')}):</strong> ${escHtml(sp?.atencion_resumen || '—')}</div>
      <div>${escHtml(sp?.proceso_venta_resumen || qd?.cotizacion_evidence || '—')}</div>
      ${sp?.cambios_desde_ultimo_analisis
    ? `<div><strong>Cambios desde último análisis:</strong> ${escHtml(sp.cambios_desde_ultimo_analisis)}</div>`
    : ''}
      ${newMsgs != null ? `<div class="supervisor-card-meta">Mensajes nuevos en este análisis: ${escHtml(String(newMsgs))}</div>` : ''}
      <div><strong>Próximo paso:</strong> ${escHtml(sp?.proximo_paso_comercial || sp?.seguimiento_resumen || '—')}</div>
    </div>
  `;
}

function participantSection(title, present, score, summary, issues, recommendation, meta = '') {
  if (!present && !summary && !asList(issues).length && !recommendation) return '';
  const scoreText = score == null ? '—' : String(score);
  const issuesHtml = asList(issues).length
    ? `<div><strong>Observaciones ${escHtml(title)}:</strong> ${escHtml(asList(issues).join(' · '))}</div>`
    : '';
  const metaHtml = meta ? `<div class="supervisor-card-meta">${escHtml(meta)}</div>` : '';
  return `
    <div class="supervisor-card-section">
      <div><strong>${escHtml(title)}:</strong> ${present ? 'Intervino' : 'Sin intervención'} · Score ${escHtml(scoreText)}</div>
      ${metaHtml}
      <div>${escHtml(summary || 'Sin resumen específico.')}</div>
      ${issuesHtml}
      <div><strong>Recomendación ${escHtml(title)}:</strong> ${escHtml(recommendation || '—')}</div>
    </div>
  `;
}

function formatDebugLogLine(entry) {
  const meta = entry.data && Object.keys(entry.data).length
    ? ' ' + JSON.stringify(entry.data)
    : '';
  const cls =
    entry.level === 'error'
      ? 'log-line-error'
      : entry.level === 'warn'
        ? 'log-line-warn'
        : entry.level === 'debug'
          ? 'log-line-debug'
          : 'log-line-info';
  return `<span class="${cls}">[${entry.elapsed_ms}ms] ${escHtml(entry.step)}${escHtml(meta)}</span>`;
}

function renderSupervisorDebugLog(debug, runId) {
  const panel = document.getElementById('supervisor-debug-panel');
  const pre = document.getElementById('supervisor-debug-log');
  const summaryEl = document.getElementById('supervisor-debug-summary');
  const runEl = document.getElementById('supervisor-debug-run-id');
  if (!panel || !pre) return;

  const events = debug.events || debug.last_events || [];
  if (!events.length) {
    panel.hidden = true;
    return;
  }

  panel.hidden = false;
  if (runEl) runEl.textContent = runId || debug.run_id || '';

  const s = debug.summary || {};
  summaryEl.innerHTML = `
    Estado: <strong>${escHtml(debug.status || '—')}</strong> ·
    Duración: <strong>${escHtml(String(debug.duration_ms ?? '—'))} ms</strong> ·
    Conversaciones: <strong>${escHtml(String(s.conversations_total ?? '—'))}</strong> ·
    Analizadas: <strong>${escHtml(String(s.analyzed ?? '—'))}</strong> ·
    Errores: <strong>${escHtml(String(s.errors_count ?? 0))}</strong>
    ${events.length < 20 ? '' : ' · <span class="field-hint">(últimos eventos; ver consola del servidor o GET /api/supervisor/logs)</span>'}
  `;

  pre.innerHTML = events.map(formatDebugLogLine).join('\n');
  pre.scrollTop = pre.scrollHeight;
}

function toggleSupervisorDebug() {
  const panel = document.getElementById('supervisor-debug-panel');
  if (panel) panel.hidden = !panel.hidden;
}

function hasInactivityInterestTag(tags) {
  const list = Array.isArray(tags) ? tags : [];
  return list.includes('inactiva_interes_real') || list.includes('inactiva_25d_interes_real');
}

function inactiveInterestBadge(report) {
  const tags = report.metrics?.supervisor_tags || [];
  if (!hasInactivityInterestTag(tags)) return '';
  const days = report.metrics?.days_since_last_interaction;
  const threshold = report.metrics?.inactivity_tagging?.inactive_threshold_days || 2;
  const daysLabel = days != null ? `${days}d` : `+${threshold}d`;
  return `<span class="badge badge-inactive" title="Sin interacción ≥${threshold} días con interés comercial previo">Inactiva ${daysLabel} · interés real</span>`;
}

function renderSupervisorReports(reports, summary) {
  const el = document.getElementById('supervisor-results');
  el.classList.add('show');

  if (!reports.length) {
    el.innerHTML = `<div class="supervisor-summary">${escHtml(summary || 'Sin reportes.')}</div>`;
    return;
  }

  el.innerHTML = `
    <div class="supervisor-summary">${escHtml(summary || '')}</div>
    ${reports.map(report => {
      const title = report.contact_name || `Conversación ${report.conversation_id}`;
      const score = report.score_general == null ? '—' : String(report.score_general);
      const inactiveBadge = inactiveInterestBadge(report);
      const alerts = Array.isArray(report.alerts) && report.alerts.length
        ? `<div><strong>Alertas:</strong> ${escHtml(report.alerts.join(' · '))}</div>`
        : '';
      const architectNames = asList(report.architect_names).join(', ') || 'sin nombre identificado';
      const aiAgentBlock = participantSection(
        'AI Agent',
        report.ai_agent_present,
        report.ai_agent_score,
        report.ai_agent_summary,
        report.ai_agent_issues,
        report.ai_agent_recommendation,
        `Usuario AI: Super Admin · Mensajes salientes: ${report.ai_agent_outbound_count || 0}`
      );
      const architectBlock = participantSection(
        'Arquitecto',
        report.architect_present,
        report.architect_score,
        report.architect_summary,
        report.architect_issues,
        report.architect_recommendation,
        `Arquitecto(s): ${architectNames} · Mensajes salientes: ${report.architect_outbound_count || 0}`
      );
      const handoff = report.handoff_summary
        ? `<div><strong>Traspaso AI → Arquitecto (${escHtml(report.handoff_quality || 'no_aplica')}):</strong> ${escHtml(report.handoff_summary)}</div>`
        : '';
      const url = report.conversation_url
        ? `<a class="conv-link" href="${escAttr(report.conversation_url)}" target="_blank" rel="noopener noreferrer">Abrir conversación</a>`
        : '';
      return `
        <div class="supervisor-card">
          <div class="supervisor-card-head">
            <div>
              <div class="supervisor-card-title">${escHtml(title)}</div>
              <div class="supervisor-card-meta">${escHtml(report.branch_name || '—')} · ${escHtml(report.stage || 'indefinida')} · Score ${escHtml(score)}</div>
            </div>
            <div class="supervisor-card-badges">
              ${inactiveBadge}
              ${riskBadge(report.risk_level)}
            </div>
          </div>
          <div class="supervisor-card-body">
            <div>${escHtml(report.summary || 'Sin resumen.')}</div>
            ${alerts}
            ${salesProcessSection(report)}
            ${aiAgentBlock}
            ${architectBlock}
            ${handoff}
            <div><strong>Recomendación:</strong> ${escHtml(report.recommendation || '—')}</div>
            <div>${url}</div>
          </div>
        </div>
      `;
    }).join('')}
  `;
}

function renderConversationIds() {
  document.getElementById('ids-count').textContent = `${conversationIds.length} IDs`;
  document.getElementById('ids-list').textContent = conversationIds.join('\n');
}

async function copyConversationIds() {
  if (!conversationIds.length) {
    showError('No hay IDs de conversaciones para copiar.');
    return;
  }

  hideError();
  try {
    await navigator.clipboard.writeText(conversationIds.join('\n'));
    showStatus(`IDs copiados al portapapeles (${conversationIds.length})`);
    setTimeout(hideStatus, 1200);
  } catch (err) {
    showError('No se pudieron copiar los IDs. Revisa permisos del navegador.');
  }
}

function buildConversationPath(accountId, page, selectedBranch) {
  const params = new URLSearchParams();
  const branchId = selectedBranch?.id || '49';
  params.set('inbox_id', String(branchId));
  params.set('page', String(page));
  return `/api/v1/accounts/${accountId}/conversations?${params.toString()}`;
}

function buildMessagesPath(accountId, conversationId) {
  return `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
}

async function chatwootFetch(context, path) {
  const useProxy = Boolean(context.proxyUrl);
  const url = useProxy
    ? `${context.proxyUrl}/chatwoot${path}`
    : `${context.baseUrl}${path}`;
  const headers = { api_access_token: context.token };
  if (useProxy) {
    headers['x-chatwoot-base-url'] = context.baseUrl;
  }
  const fetchFn = useProxy && window.OntimeAuth?.authFetch ? window.OntimeAuth.authFetch : fetch;
  const response = await fetchFn(url, { headers });
  if (response.status === 401 && window.OntimeAuth) {
    await window.OntimeAuth.signOut();
    throw new Error('Sesión expirada. Inicia sesión de nuevo.');
  }
  return response;
}

async function fetchConversationList(context, accountId, limit, selectedBranch) {
  const PER_PAGE = 25;
  const maxPages = Math.ceil(limit / PER_PAGE);
  const conversations = [];

  for (let page = 1; page <= maxPages; page++) {
    showStatus(`Cargando IDs de conversaciones... página ${page}/${maxPages}`);
    const convPath = buildConversationPath(accountId, page, selectedBranch);
    if (page === 1) {
      console.log('Filtro seleccionado:', selectedBranch);
      console.log('Query enviada:', convPath);
    }
    const res = await chatwootFetch(context, convPath);

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    const convs = data?.data?.payload || data?.payload || [];
    if (!convs.length) break;

    for (const conv of convs) {
      conversations.push(conv);
      if (conversations.length >= limit) break;
    }

    if (conversations.length >= limit || convs.length < PER_PAGE) break;
  }

  return conversations;
}

function renderStats() {
  const now = Date.now();
  const day = 86400000;
  const recent = allRows.filter(r => now - r.lastOutboundAt < day).length;
  const old = allRows.filter(r => now - r.lastOutboundAt >= 7 * day).length;

  document.getElementById('stats-row').innerHTML = `
    <div class="stat-card">
      <div class="stat-value">${allRows.length}</div>
      <div class="stat-label">Clientes con mensajes</div>
    </div>
    <div class="stat-card">
      <div class="stat-value stat-value-alt-green">${recent}</div>
      <div class="stat-label">Contactados hoy</div>
    </div>
    <div class="stat-card">
      <div class="stat-value stat-value-alt-warm">${old}</div>
      <div class="stat-label">Sin contacto +7 días</div>
    </div>
  `;
}

function applyFilters() {
  const q = document.getElementById('search-input').value.toLowerCase();
  const sort = document.getElementById('sort-select').value;

  filteredRows = allRows.filter(r =>
    r.name.toLowerCase().includes(q) ||
    r.email.toLowerCase().includes(q) ||
    r.phone.toLowerCase().includes(q)
  );

  if (sort === 'newest') filteredRows.sort((a, b) => b.lastOutboundAt - a.lastOutboundAt);
  else if (sort === 'oldest') filteredRows.sort((a, b) => a.lastOutboundAt - b.lastOutboundAt);
  else filteredRows.sort((a, b) => a.name.localeCompare(b.name));

  currentPage = 1;
  renderTable();
}

function renderTable() {
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageRows = filteredRows.slice(start, start + PAGE_SIZE);
  const tbody = document.getElementById('table-body');
  const now = Date.now();

  if (!pageRows.length) {
    tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-text">Sin resultados para tu búsqueda</div></div></td></tr>';
  } else {
    tbody.innerHTML = pageRows.map(r => {
      const initials = r.name.split(' ').map(w => w[0] || '').join('').slice(0, 2).toUpperCase();
      const dt = new Date(r.lastOutboundAt);
      const absTime = dt.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' +
                      dt.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
      const diff = now - r.lastOutboundAt;
      const relTime = relativeTime(diff);
      const ageBadge = diff < 86400000
        ? '<span class="badge badge-green">Hoy</span>'
        : diff < 7 * 86400000
        ? `<span class="badge badge-yellow">${relTime}</span>`
        : `<span class="badge badge-red">${relTime}</span>`;

      const statusBadge = r.status === 'resolved'
        ? '<span class="badge badge-gray">Resuelto</span>'
        : r.status === 'open'
        ? '<span class="badge badge-green">Abierto</span>'
        : `<span class="badge badge-yellow">${r.status}</span>`;

      const convLinkCell = r.conversationUrl
        ? `<a class="conv-link" href="${escAttr(r.conversationUrl)}" target="_blank" rel="noopener noreferrer">${escHtml(r.conversationUrl)}</a>`
        : '—';

      return `<tr>
        <td>
          <div class="contact-cell">
            <div class="avatar">${initials}</div>
            <div>
              <div class="contact-name">${escHtml(r.name)}</div>
              <div class="contact-id">${escHtml(r.email !== '—' ? r.email : '')}</div>
            </div>
          </div>
        </td>
        <td class="time-cell">${escHtml(r.phone !== '—' ? r.phone : '—')}</td>
        <td>
          <div class="time-cell">
            <div class="time-abs">${absTime}</div>
            <div class="time-rel">${ageBadge}</div>
          </div>
        </td>
        <td>${escHtml(r.lastOutboundSenderName || '—')}</td>
        <td><span class="badge badge-gray">${escHtml(r.inbox)}</span></td>
        <td>${statusBadge}</td>
        <td class="conv-url-cell">${convLinkCell}</td>
        <td><span class="direction-out" title="Saliente (agente → cliente)">↗</span></td>
      </tr>`;
    }).join('');
  }

  renderPagination();
}

function relativeTime(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `hace ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `hace ${d}d`;
  const mo = Math.floor(d / 30);
  return `hace ${mo} mes${mo > 1 ? 'es' : ''}`;
}

function renderPagination() {
  const total = filteredRows.length;
  const pages = Math.ceil(total / PAGE_SIZE);
  document.getElementById('page-info').textContent =
    `Mostrando ${Math.min((currentPage - 1) * PAGE_SIZE + 1, total)}–${Math.min(currentPage * PAGE_SIZE, total)} de ${total} clientes`;

  const btns = document.getElementById('page-btns');
  if (pages <= 1) {
    btns.innerHTML = '';
    return;
  }

  let html = `<button class="page-btn" onclick="goPage(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''}>‹</button>`;
  for (let i = 1; i <= pages; i++) {
    if (pages > 7 && Math.abs(i - currentPage) > 2 && i !== 1 && i !== pages) {
      if (i === 2 || i === pages - 1) html += '<span style="color:var(--muted);padding:0 4px">…</span>';
      continue;
    }
    html += `<button class="page-btn${i === currentPage ? ' active' : ''}" onclick="goPage(${i})">${i}</button>`;
  }
  html += `<button class="page-btn" onclick="goPage(${currentPage + 1})" ${currentPage === pages ? 'disabled' : ''}>›</button>`;
  btns.innerHTML = html;
}

function goPage(p) {
  const pages = Math.ceil(filteredRows.length / PAGE_SIZE);
  if (p < 1 || p > pages) return;
  currentPage = p;
  renderTable();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function exportCSV() {
  if (!filteredRows.length) return;
  const headers = ['ID', 'Nombre', 'Email', 'Teléfono', 'Último Msg Saliente', 'Asesor', 'Canal', 'Estado', 'URL conversación', 'Conv ID'];
  const rows = filteredRows.map(r => [
    r.id, r.name, r.email, r.phone,
    new Date(r.lastOutboundAt).toISOString(),
    r.lastOutboundSenderName || '',
    r.inbox, r.status,
    r.conversationUrl || '',
    r.convId
  ]);
  const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `chatwoot-ultimo-mensaje-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

document.addEventListener('DOMContentLoaded', async () => {
  if (window.OntimeAuth) {
    const ok = await window.OntimeAuth.requireAuth();
    if (!ok) return;
    window.OntimeAuth.mountUserBar();
  }

  const params = new URLSearchParams(window.location.search);
  const tab = params.get('tab');
  if (tab === 'reportes') switchAppTab('reportes');
  else if (tab === 'seguimiento') switchAppTab('seguimiento');
});
