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
const reportReanalyzeInFlight = new Set();

const CRON_INBOX_OPTIONS = [
  { id: '51', name: 'cenontime' },
  { id: '49', name: 'HmoOntime' },
  { id: '48', name: 'nogontime' },
  { id: '52', name: 'FB Hermosillo OTC' }
];

const agentCronState = { schedules: [] };

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
    const skippedLabels =
      data.skipped_excluded_labels != null && data.skipped_excluded_labels > 0
        ? ` · Ignoradas por etiqueta Chatwoot: ${data.skipped_excluded_labels}`
        : '';
    const eligible = data.eligible_after_label_filter ?? data.fetched;
    renderSupervisorDebugLog(data.debug, data.run_id);
    renderSupervisorReports(
      data.reports || [],
      `AI analizó ${data.analyzed}/${eligible} conversaciones elegibles (${data.fetched} con actividad en ${data.activity_window_hours || 24}h)${skippedLabels}. Guardado: ${data.stored ? 'sí' : 'no'}${taggedInfo}${snapInfo}${data.errors?.length ? ` · Errores: ${data.errors.length}` : ''}${data.run_id ? ` · Log: ${data.run_id}` : ''}`
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
    seguimiento: 'tab-seguimiento',
    configuracion: 'tab-configuracion'
  };
  const buttons = {
    supervisor: 'tab-btn-supervisor',
    reportes: 'tab-btn-reportes',
    seguimiento: 'tab-btn-seguimiento',
    configuracion: 'tab-btn-configuracion'
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
  if (tabId === 'configuracion') loadAgentSettingsTab();
}

const agentArchitectState = { catalog: [], selected: [] };
const agentExcludedLabelsState = { labels: [] };
const agentPromptState = { playbookBase: '', effectiveOnLoad: '' };

function syncPromptModeBadge(useCustom) {
  const badge = document.getElementById('cfg-prompt-mode-badge');
  if (!badge) return;
  badge.textContent = useCustom ? 'Personalizado' : 'Playbook integrado';
  badge.classList.toggle('custom', Boolean(useCustom));
}

function toggleCustomPromptFields() {
  syncPromptModeBadge(document.getElementById('cfg-use-custom-prompt')?.checked);
}

function loadPlaybookIntoPromptEditor() {
  const useCustom = document.getElementById('cfg-use-custom-prompt');
  if (useCustom) useCustom.checked = false;
  const extra = document.getElementById('cfg-system-prompt-extra')?.value?.trim() || '';
  const base = agentPromptState.playbookBase || '';
  const ta = document.getElementById('cfg-effective-prompt');
  if (ta) ta.value = extra ? `${base}\n\n${extra}` : base;
  syncPromptModeBadge(false);
}

function onPromptExtraInput() {
  if (!document.getElementById('cfg-use-custom-prompt')?.checked) {
    loadPlaybookIntoPromptEditor();
  }
}

function parsePromptFieldsForSave() {
  const effective = (document.getElementById('cfg-effective-prompt')?.value || '').trim();
  const extra = (document.getElementById('cfg-system-prompt-extra')?.value || '').trim();
  const useCustomFlag = Boolean(document.getElementById('cfg-use-custom-prompt')?.checked);
  const playbookWithExtra = extra
    ? `${agentPromptState.playbookBase}\n\n${extra}`
    : agentPromptState.playbookBase;
  const edited = effective !== (agentPromptState.effectiveOnLoad || '').trim();
  const useCustom = useCustomFlag || edited || effective !== playbookWithExtra.trim();

  if (!useCustom) {
    return {
      use_custom_system_prompt: false,
      system_prompt: '',
      system_prompt_extra: extra
    };
  }

  let systemPrompt = effective;
  if (extra && effective.endsWith(extra)) {
    systemPrompt = effective.slice(0, effective.length - extra.length).replace(/\n\n$/, '').trim();
  }

  if (systemPrompt.length < 40) {
    throw new Error('El system prompt personalizado debe tener al menos 40 caracteres.');
  }

  return {
    use_custom_system_prompt: true,
    system_prompt: systemPrompt,
    system_prompt_extra: extra
  };
}

function renderCurrentConfigSummary(settings) {
  const grid = document.getElementById('cfg-current-grid');
  if (!grid || !settings) return;

  const promptMode = settings.prompt_mode === 'personalizado' || settings.use_custom_system_prompt
    ? 'Prompt personalizado'
    : `Playbook integrado (${settings.playbook_version || 'v1'})`;
  const promptChars = (settings.effective_system_prompt || '').length;
  const architects = (settings.architect_sender_names || []).join(', ') || '—';
  const stages = (settings.followup_stages || []).join(', ') || '—';
  const sourceLabel =
    settings.source === 'file' ? 'Archivo guardado (servidor)' : 'Variables de entorno (.env)';
  const updated =
    settings.updated_at
      ? `${new Date(settings.updated_at).toLocaleString('es-MX')} · ${settings.updated_by || '?'}`
      : 'Sin cambios guardados desde la UI';

  grid.innerHTML = `
    <div class="cfg-current-item"><label>Origen</label><span class="cfg-current-value">${escHtml(sourceLabel)}</span></div>
    <div class="cfg-current-item"><label>Modelo OpenAI</label><span class="cfg-current-value">${escHtml(settings.openai_model || '—')}</span></div>
    <div class="cfg-current-item"><label>Playbook</label><span class="cfg-current-value">${escHtml(settings.playbook_version || 'v2')}${settings.playbook_version_env ? ` (fijado en .env: ${escHtml(settings.playbook_version_env)})` : ''}</span></div>
    <div class="cfg-current-item"><label>System prompt</label><span class="cfg-current-value">${escHtml(promptMode)} · ${promptChars} caracteres</span></div>
    <div class="cfg-current-item"><label>AI Agent (Chatwoot)</label><span class="cfg-current-value">${escHtml(settings.ai_agent_sender_name || '—')}</span></div>
    <div class="cfg-current-item cfg-wide"><label>Arquitectos activos</label><span class="cfg-current-value">${escHtml(architects)}</span></div>
    <div class="cfg-current-item cfg-wide"><label>Etiquetas excluidas (no analizar)</label><span class="cfg-current-value">${escHtml((settings.excluded_chatwoot_labels || []).join(', ') || '—')}${settings.excluded_labels_env_override ? ' · lista fijada en .env' : ''}</span></div>
    <div class="cfg-current-item"><label>Ventana Chatwoot</label><span class="cfg-current-value">${escHtml(String(settings.chatwoot_activity_window_hours))} h</span></div>
    <div class="cfg-current-item"><label>Etiqueta inactiva</label><span class="cfg-current-value">≥ ${escHtml(String(settings.inactive_days_threshold))} días</span></div>
    <div class="cfg-current-item"><label>Temperatura</label><span class="cfg-current-value">${escHtml(String(settings.openai_temperature))}</span></div>
    <div class="cfg-current-item"><label>Rondas agente</label><span class="cfg-current-value">${escHtml(String(settings.agent_max_rounds))}</span></div>
    <div class="cfg-current-item"><label>Tools / ronda</label><span class="cfg-current-value">${escHtml(String(settings.agent_max_tools_per_round))}</span></div>
    <div class="cfg-current-item cfg-wide"><label>Etapas seguimiento</label><span class="cfg-current-value">${escHtml(stages)}</span></div>
    <div class="cfg-current-item cfg-wide"><label>Scheduler</label><span class="cfg-current-value">${settings.cron_enabled ? `Activo · ${(settings.cron_schedules || []).filter(s => s.enabled !== false).length} horario(s) · ${escHtml(settings.cron_timezone || 'America/Hermosillo')}` : 'Desactivado'}${settings.scheduler?.active_jobs != null ? ` · ${settings.scheduler.active_jobs} job(s) en memoria` : ''}</span></div>
    <div class="cfg-current-item cfg-wide"><label>Última actualización</label><span class="cfg-current-value">${escHtml(updated)}</span></div>
  `;
}

function renderArchitectPicker(catalog, selected) {
  agentArchitectState.catalog = [...new Set((catalog || []).map(n => String(n).trim()).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b, 'es')
  );
  agentArchitectState.selected = [...new Set((selected || []).map(n => String(n).trim()).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b, 'es')
  );

  const select = document.getElementById('cfg-architect-add');
  if (select) {
    const currentVal = select.value;
    select.innerHTML =
      '<option value="">— Elegir arquitecto —</option>' +
      agentArchitectState.catalog
        .map(name => {
          const active = agentArchitectState.selected.includes(name);
          return `<option value="${escHtml(name)}"${active ? ' disabled' : ''}>${escHtml(name)}${active ? ' ✓ activo' : ''}</option>`;
        })
        .join('');
    if (currentVal && agentArchitectState.catalog.includes(currentVal)) {
      select.value = currentVal;
    }
  }

  const chips = document.getElementById('cfg-architect-chips');
  if (!chips) return;
  if (!agentArchitectState.selected.length) {
    chips.innerHTML = '<span class="architect-chips-empty">Ningún arquitecto activo. Elige uno del menú desplegable.</span>';
    return;
  }
  chips.innerHTML = agentArchitectState.selected
    .map(
      name => `
    <span class="architect-chip">
      ${escHtml(name)}
      <button type="button" title="Quitar" aria-label="Quitar" data-architect="${escHtml(encodeURIComponent(name))}" onclick="removeArchitectChip(this.getAttribute('data-architect'))">×</button>
    </span>`
    )
    .join('');
}

function collectArchitectNames() {
  return [...agentArchitectState.selected];
}

function normalizeLabelInput(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function renderExcludedLabelChips(labels) {
  agentExcludedLabelsState.labels = [...new Set((labels || []).map(normalizeLabelInput).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b, 'es')
  );

  const countEl = document.getElementById('cfg-excluded-label-count');
  if (countEl) countEl.textContent = String(agentExcludedLabelsState.labels.length);

  const chips = document.getElementById('cfg-excluded-label-chips');
  if (!chips) return;
  if (!agentExcludedLabelsState.labels.length) {
    chips.innerHTML =
      '<span class="architect-chips-empty">Ninguna etiqueta excluida. Las conversaciones con cualquier etiqueta podrán analizarse.</span>';
    return;
  }
  chips.innerHTML = agentExcludedLabelsState.labels
    .map(
      label => `
    <span class="excluded-label-chip">
      ${escHtml(label)}
      <button type="button" title="Quitar" aria-label="Quitar" data-label="${escHtml(encodeURIComponent(label))}" onclick="removeExcludedLabelChip(this.getAttribute('data-label'))">×</button>
    </span>`
    )
    .join('');
}

function collectExcludedChatwootLabels() {
  return [...agentExcludedLabelsState.labels];
}

function addExcludedChatwootLabel() {
  const input = document.getElementById('cfg-excluded-label-new');
  const raw = input?.value?.trim();
  if (!raw) {
    showError('Escribe el nombre de la etiqueta como aparece en Chatwoot.');
    return;
  }
  const label = normalizeLabelInput(raw);
  if (!/^[a-z0-9_-]+$/.test(label)) {
    showError('Usa solo letras, números, guión y guión bajo (sin espacios).');
    return;
  }
  if (!agentExcludedLabelsState.labels.includes(label)) {
    agentExcludedLabelsState.labels.push(label);
    agentExcludedLabelsState.labels.sort((a, b) => a.localeCompare(b, 'es'));
  }
  if (input) input.value = '';
  renderExcludedLabelChips(agentExcludedLabelsState.labels);
}

function removeExcludedLabelChip(encodedLabel) {
  const label = decodeURIComponent(encodedLabel || '');
  agentExcludedLabelsState.labels = agentExcludedLabelsState.labels.filter(l => l !== label);
  renderExcludedLabelChips(agentExcludedLabelsState.labels);
}

function addArchitectFromDropdown() {
  const select = document.getElementById('cfg-architect-add');
  const name = select?.value?.trim();
  if (!name) return;
  if (!agentArchitectState.selected.includes(name)) {
    agentArchitectState.selected.push(name);
    agentArchitectState.selected.sort((a, b) => a.localeCompare(b, 'es'));
  }
  if (select) select.value = '';
  renderArchitectPicker(agentArchitectState.catalog, agentArchitectState.selected);
}

function removeArchitectChip(encodedName) {
  const name = decodeURIComponent(encodedName || '');
  agentArchitectState.selected = agentArchitectState.selected.filter(n => n !== name);
  renderArchitectPicker(agentArchitectState.catalog, agentArchitectState.selected);
}

function addArchitectToCatalog() {
  const input = document.getElementById('cfg-architect-new');
  const name = input?.value?.trim();
  if (!name) {
    showError('Escribe el nombre del arquitecto como aparece en Chatwoot.');
    return;
  }
  if (!agentArchitectState.catalog.includes(name)) {
    agentArchitectState.catalog.push(name);
    agentArchitectState.catalog.sort((a, b) => a.localeCompare(b, 'es'));
  }
  if (!agentArchitectState.selected.includes(name)) {
    agentArchitectState.selected.push(name);
    agentArchitectState.selected.sort((a, b) => a.localeCompare(b, 'es'));
  }
  if (input) input.value = '';
  renderArchitectPicker(agentArchitectState.catalog, agentArchitectState.selected);
}

function fillAgentSettingsForm(settings) {
  if (!settings) return;
  const useCustom = document.getElementById('cfg-use-custom-prompt');
  if (useCustom) useCustom.checked = Boolean(settings.use_custom_system_prompt);
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val ?? '';
  };
  agentPromptState.playbookBase = settings.playbook_system_prompt || '';
  agentPromptState.effectiveOnLoad = settings.effective_system_prompt || '';
  setVal('cfg-effective-prompt', settings.effective_system_prompt);
  setVal('cfg-system-prompt-extra', settings.system_prompt_extra);
  setVal('cfg-workflow-extra', settings.agent_workflow_extra);
  syncPromptModeBadge(settings.use_custom_system_prompt);
  setVal('cfg-ai-agent-name', settings.ai_agent_sender_name);
  setVal('cfg-inactive-days', settings.inactive_days_threshold);
  setVal('cfg-window-hours', settings.chatwoot_activity_window_hours);
  setVal('cfg-temperature', settings.openai_temperature);
  setVal('cfg-max-rounds', settings.agent_max_rounds);
  setVal('cfg-max-tools', settings.agent_max_tools_per_round);
  setVal('cfg-followup-stages', (settings.followup_stages || []).join(', '));
  setVal('cfg-playbook-version', settings.playbook_version || 'v2');
  renderArchitectPicker(
    settings.architect_catalog || settings.architect_sender_names,
    settings.architect_sender_names
  );
  renderExcludedLabelChips(settings.excluded_chatwoot_labels || []);
  renderCurrentConfigSummary(settings);
  fillCronSettingsForm(settings);
  const meta = document.getElementById('cfg-meta');
  if (meta) {
    meta.textContent = settings.updated_at
      ? `Última guardado: ${settings.updated_by || '?'} · ${new Date(settings.updated_at).toLocaleString('es-MX')} · origen: ${settings.source}`
      : `Sin archivo guardado · origen: ${settings.source || 'env'}`;
  }
}

function collectAgentSettingsFromForm() {
  const promptFields = parsePromptFieldsForSave();
  return {
    ...promptFields,
    agent_workflow_extra: document.getElementById('cfg-workflow-extra')?.value || '',
    ai_agent_sender_name: document.getElementById('cfg-ai-agent-name')?.value.trim() || '',
    architect_catalog: agentArchitectState.catalog,
    architect_sender_names: collectArchitectNames(),
    excluded_chatwoot_labels: collectExcludedChatwootLabels(),
    inactive_days_threshold: parseInt(document.getElementById('cfg-inactive-days')?.value || '2', 10),
    chatwoot_activity_window_hours: parseInt(document.getElementById('cfg-window-hours')?.value || '24', 10),
    openai_temperature: parseFloat(document.getElementById('cfg-temperature')?.value || '0.1'),
    agent_max_rounds: parseInt(document.getElementById('cfg-max-rounds')?.value || '10', 10),
    agent_max_tools_per_round: parseInt(document.getElementById('cfg-max-tools')?.value || '5', 10),
    followup_stages: (document.getElementById('cfg-followup-stages')?.value || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    playbook_version: (document.getElementById('cfg-playbook-version')?.value || 'v2').trim(),
    cron_enabled: Boolean(document.getElementById('cfg-cron-enabled')?.checked),
    cron_timezone: (document.getElementById('cfg-cron-timezone')?.value || 'America/Hermosillo').trim(),
    cron_sync_followup: Boolean(document.getElementById('cfg-cron-sync-followup')?.checked),
    cron_schedules: collectCronSchedulesFromForm()
  };
}

function cronBranchNameForInbox(inboxId, explicit) {
  const id = String(inboxId || '').trim();
  if (explicit && String(explicit).trim()) return String(explicit).trim();
  return BRANCH_NAME_BY_ID[id] || `Inbox ${id}`;
}

function normalizeCronTimeValue(time) {
  const raw = String(time || '').trim();
  if (!raw) return '22:00';
  const match = raw.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return '22:00';
  return `${String(parseInt(match[1], 10)).padStart(2, '0')}:${match[2]}`;
}

function renderCronScheduleRows(schedules) {
  const tbody = document.getElementById('cfg-cron-schedules-body');
  if (!tbody) return;
  const list = Array.isArray(schedules) && schedules.length ? schedules : [
    { inbox_id: '51', branch_name: 'cenontime', time: '22:00', enabled: true }
  ];
  agentCronState.schedules = list.map(s => ({ ...s }));

  tbody.innerHTML = list
    .map((row, index) => {
      const inboxOptions = CRON_INBOX_OPTIONS.map(
        opt =>
          `<option value="${escAttr(opt.id)}"${String(row.inbox_id) === opt.id ? ' selected' : ''}>${escHtml(opt.id)} · ${escHtml(opt.name)}</option>`
      ).join('');
      const branch = cronBranchNameForInbox(row.inbox_id, row.branch_name);
      const timeVal = normalizeCronTimeValue(row.time);
      const enabled = row.enabled !== false;
      return `
        <tr data-cron-index="${index}">
          <td>
            <select class="sort-select cron-inbox-select" data-index="${index}" onchange="onCronInboxChange(${index})">
              ${inboxOptions}
            </select>
          </td>
          <td><input type="text" class="search-input cron-branch-input" data-index="${index}" value="${escAttr(branch)}" placeholder="Nombre sucursal"></td>
          <td><input type="time" class="search-input cron-time-input" data-index="${index}" value="${escAttr(timeVal)}"></td>
          <td><input type="checkbox" class="cron-enabled-input" data-index="${index}"${enabled ? ' checked' : ''}></td>
          <td><button type="button" class="btn btn-secondary btn-sm" onclick="removeCronScheduleRow(${index})">Quitar</button></td>
        </tr>
      `;
    })
    .join('');
}

function onCronInboxChange(index) {
  const select = document.querySelector(`.cron-inbox-select[data-index="${index}"]`);
  const branchInput = document.querySelector(`.cron-branch-input[data-index="${index}"]`);
  if (select && branchInput) {
    branchInput.value = cronBranchNameForInbox(select.value);
  }
}

function addCronScheduleRow() {
  const current = collectCronSchedulesFromForm();
  current.push({ inbox_id: '49', branch_name: 'HmoOntime', time: '22:30', enabled: true });
  renderCronScheduleRows(current);
}

function removeCronScheduleRow(index) {
  const current = collectCronSchedulesFromForm();
  current.splice(index, 1);
  renderCronScheduleRows(current.length ? current : [{ inbox_id: '51', branch_name: 'cenontime', time: '22:00', enabled: true }]);
}

function collectCronSchedulesFromForm() {
  const rows = document.querySelectorAll('#cfg-cron-schedules-body tr[data-cron-index]');
  const out = [];
  rows.forEach(tr => {
    const index = tr.getAttribute('data-cron-index');
    const inboxId = tr.querySelector(`.cron-inbox-select[data-index="${index}"]`)?.value?.trim();
    const branchName = tr.querySelector(`.cron-branch-input[data-index="${index}"]`)?.value?.trim();
    const time = tr.querySelector(`.cron-time-input[data-index="${index}"]`)?.value?.trim();
    const enabled = tr.querySelector(`.cron-enabled-input[data-index="${index}"]`)?.checked;
    if (!inboxId || !time) return;
    out.push({
      inbox_id: inboxId,
      branch_name: branchName || cronBranchNameForInbox(inboxId),
      time: normalizeCronTimeValue(time),
      enabled: Boolean(enabled)
    });
  });
  return out;
}

function renderCronSchedulerStatus(scheduler) {
  const el = document.getElementById('cfg-cron-status');
  if (!el || !scheduler) return;
  const lines = [];
  lines.push(
    scheduler.enabled
      ? `Estado: activo · ${scheduler.active_jobs} tarea(s) programada(s) · TZ ${scheduler.timezone}`
      : 'Estado: desactivado (activa el checkbox y guarda)'
  );
  if (scheduler.last_runs?.length) {
    const last = scheduler.last_runs[0];
    lines.push(
      `Última ejecución: inbox ${last.inbox_id} · ${last.status} · ${last.analyzed ?? '—'} analizadas · ${new Date(last.at).toLocaleString('es-MX')}`
    );
  }
  el.innerHTML = lines.map(l => `<div>${escHtml(l)}</div>`).join('');
}

function fillCronSettingsForm(settings) {
  if (!settings) return;
  const enabled = document.getElementById('cfg-cron-enabled');
  if (enabled) enabled.checked = Boolean(settings.cron_enabled);
  setVal('cfg-cron-timezone', settings.cron_timezone || 'America/Hermosillo');
  const sync = document.getElementById('cfg-cron-sync-followup');
  if (sync) sync.checked = settings.cron_sync_followup !== false;
  renderCronScheduleRows(settings.cron_schedules || []);
  renderCronSchedulerStatus(settings.scheduler);
}

async function runScheduledAnalyzeNow() {
  const status = document.getElementById('cfg-cron-status');
  if (!confirm('¿Ejecutar ahora el análisis programado para todas las sucursales activas? Puede tardar varios minutos.')) {
    return;
  }
  try {
    if (status) status.textContent = 'Ejecutando análisis programado…';
    const data = await supervisorApi('/api/supervisor/scheduler/run', {
      method: 'POST',
      body: JSON.stringify({})
    });
    const summary = (data.runs || [])
      .map(r => `inbox ${r.inbox_id}: ${r.status} (${r.analyzed ?? 0} analizadas)`)
      .join(' · ');
    if (status) status.textContent = `Completado: ${summary || 'sin resultados'}`;
    const settingsData = await supervisorApi('/api/supervisor/settings');
    renderCronSchedulerStatus(settingsData.settings?.scheduler);
  } catch (err) {
    if (status) status.textContent = 'Error: ' + err.message;
    showError('Scheduler: ' + err.message);
  }
}

function setVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val ?? '';
}

async function loadAgentSettingsBackups() {
  try {
    const data = await supervisorApi('/api/supervisor/settings/backups?limit=25');
    const select = document.getElementById('cfg-backup-select');
    const hint = document.getElementById('cfg-backup-hint');
    if (!select) return;
    const backups = data.backups || [];
    select.innerHTML =
      '<option value="">— Elegir backup —</option>' +
      backups
        .map(b => `<option value="${escHtml(b.backup_id)}">${escHtml(b.label)}</option>`)
        .join('');
    if (hint) {
      hint.textContent = backups.length
        ? `${backups.length} backup(s). Cada guardado crea uno nuevo antes de aplicar cambios.`
        : 'Sin backups aún; el primero se crea al guardar.';
    }
  } catch (err) {
    const hint = document.getElementById('cfg-backup-hint');
    if (hint) hint.textContent = 'No se pudieron listar backups: ' + err.message;
  }
}

async function loadAgentSettingsTab() {
  const status = document.getElementById('cfg-status');
  try {
    if (status) status.textContent = 'Cargando…';
    const data = await supervisorApi('/api/supervisor/settings');
    fillAgentSettingsForm(data.settings);
    await loadAgentSettingsBackups();
    if (status) status.textContent = '';
  } catch (err) {
    if (status) status.textContent = '';
    showError('Configuración del agente: ' + err.message);
  }
}

async function saveAgentSettings() {
  const status = document.getElementById('cfg-status');
  try {
    if (status) status.textContent = 'Guardando (creando backup)…';
    const payload = collectAgentSettingsFromForm();
    const data = await supervisorApi('/api/supervisor/settings', {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    fillAgentSettingsForm(data.settings);
    await loadAgentSettingsBackups();
    const backupAt = data.backup?.backed_up_at
      ? new Date(data.backup.backed_up_at).toLocaleString('es-MX')
      : null;
    if (status) status.textContent = backupAt ? `Guardado ✓ · backup ${backupAt}` : 'Guardado ✓';
    setTimeout(() => {
      if (status?.textContent?.startsWith('Guardado')) status.textContent = '';
    }, 5000);
  } catch (err) {
    if (status) status.textContent = '';
    showError('No se pudo guardar: ' + err.message);
  }
}

async function restoreAgentSettingsBackup() {
  const backupId = document.getElementById('cfg-backup-select')?.value?.trim();
  if (!backupId) {
    showError('Elige un backup de la lista.');
    return;
  }
  if (
    !window.confirm(
      '¿Restaurar esta configuración? Se guardará un backup del estado actual antes de restaurar.'
    )
  ) {
    return;
  }
  const status = document.getElementById('cfg-status');
  try {
    if (status) status.textContent = 'Restaurando backup…';
    const data = await supervisorApi('/api/supervisor/settings/restore', {
      method: 'POST',
      body: JSON.stringify({ backup_id: backupId })
    });
    fillAgentSettingsForm(data.settings);
    await loadAgentSettingsBackups();
    if (status) status.textContent = 'Backup restaurado ✓';
    setTimeout(() => {
      if (status?.textContent === 'Backup restaurado ✓') status.textContent = '';
    }, 4000);
  } catch (err) {
    if (status) status.textContent = '';
    showError('No se pudo restaurar: ' + err.message);
  }
}

async function resetAgentSettings() {
  if (!window.confirm('¿Restaurar valores por defecto del entorno? Se eliminará la configuración guardada en el servidor.')) {
    return;
  }
  const status = document.getElementById('cfg-status');
  try {
    if (status) status.textContent = 'Restaurando…';
    const data = await supervisorApi('/api/supervisor/settings/reset', { method: 'POST', body: '{}' });
    fillAgentSettingsForm(data.settings);
    if (status) status.textContent = 'Restaurado ✓';
    setTimeout(() => {
      if (status?.textContent === 'Restaurado ✓') status.textContent = '';
    }, 3000);
  } catch (err) {
    if (status) status.textContent = '';
    showError('No se pudo restaurar: ' + err.message);
  }
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

function reportEvaluationScope(report) {
  const raw = report?.raw_analysis;
  if (!raw) return null;
  if (typeof raw === 'object') return raw.evaluation_scope || null;
  try {
    return JSON.parse(raw).evaluation_scope || null;
  } catch {
    return null;
  }
}

function isReportFueraDeAlcance(report) {
  return normalizeStageKey(report?.stage) === 'fuera_de_alcance'
    || reportEvaluationScope(report) === 'fuera_de_alcance';
}

function isReportsHideFueraAlcanceEnabled() {
  return Boolean(document.getElementById('reports-hide-fuera-alcance')?.checked);
}

function filterReportsForView(reports) {
  let list = reports;
  if (isReportsHideFueraAlcanceEnabled()) {
    list = list.filter(report => !isReportFueraDeAlcance(report));
  }
  const q = (document.getElementById('reports-search')?.value || '').trim().toLowerCase();
  if (!q) return list;
  return list.filter(report => {
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

function filterReportsBySearch(reports) {
  return filterReportsForView(reports);
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
  if (isReportsHideFueraAlcanceEnabled()) {
    chips.push('<span class="reports-chip">Sin fuera de alcance</span>');
  }
  for (const risk of RISK_ORDER) {
    if (byRisk[risk]) chips.push(`<span class="reports-chip">${risk}: ${byRisk[risk]}</span>`);
  }
  el.innerHTML = chips.join('');
}

function reportFact(label, valueHtml) {
  if (valueHtml == null || valueHtml === '' || valueHtml === '—') return '';
  return `<div class="report-fact"><span class="report-fact-label">${escHtml(label)}</span><span class="report-fact-value">${valueHtml}</span></div>`;
}

function reportFactsBlock(items) {
  const html = items.filter(Boolean).join('');
  if (!html) return '';
  return `<div class="report-row-facts">${html}</div>`;
}

function reportTextBlock(label, text) {
  if (!text) return '';
  const safe = escHtml(text);
  if (label) {
    return `<p class="report-row-text"><strong>${escHtml(label)}:</strong> ${safe}</p>`;
  }
  return `<p class="report-row-text">${safe}</p>`;
}

function salesProcessSectionReport(report) {
  const { cotizacionEnviada, urlConfirmed, sp, qd } = cotizacionEnviadaFromReport(report);

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
  const regionNote = qd && !qd.matches_branch_expected && qd.expected_region
    ? ` · Región enlace: ${escHtml(qd.cotizacion_region)} (esperada: ${escHtml(qd.expected_region)})`
    : '';

  const facts = reportFactsBlock([
    reportFact('Embudo', escHtml(sp?.funnel_stage || '—')),
    reportFact('Cotización enviada', cotizacion),
    reportFact('Enviada (URL)', `${escHtml(sentAt)} · Por: ${escHtml(qd?.cotizacion_sent_by || '—')}${regionNote}`),
    reportFact('Esperando al cliente', escHtml(espera)),
    reportFact('Seguimiento comercial', escHtml(sp?.seguimiento_comercial || '—')),
    newMsgs != null ? reportFact('Mensajes nuevos', escHtml(String(newMsgs))) : ''
  ]);

  const narratives = [
    sp?.atencion_resumen
      ? reportTextBlock(`Atención (${sp.atencion_calidad || '—'})`, sp.atencion_resumen)
      : '',
    sp?.proceso_venta_resumen || qd?.cotizacion_evidence
      ? reportTextBlock('Detalle del proceso', sp?.proceso_venta_resumen || qd?.cotizacion_evidence)
      : '',
    sp?.cambios_desde_ultimo_analisis
      ? reportTextBlock('Cambios desde último análisis', sp.cambios_desde_ultimo_analisis)
      : '',
    reportTextBlock('Próximo paso', sp?.proximo_paso_comercial || sp?.seguimiento_resumen || '')
  ].filter(Boolean).join('');

  return `
    <div class="supervisor-card-section sales-process-section report-row-block">
      <h5 class="report-row-block-title">Proceso de venta</h5>
      ${facts}
      ${narratives}
    </div>
  `;
}

function participantSectionReport(title, present, score, summary, issues, recommendation, meta = '') {
  if (!present && !summary && !asList(issues).length && !recommendation) return '';
  const scoreText = score == null ? '—' : String(score);
  const issuesList = asList(issues);
  const facts = reportFactsBlock([
    reportFact('Intervención', present ? 'Intervino' : 'Sin intervención'),
    reportFact('Score', escHtml(scoreText)),
    meta ? reportFact('Detalle', escHtml(meta)) : ''
  ]);
  const narratives = [
    summary ? reportTextBlock('Resumen', summary) : '',
    issuesList.length ? reportTextBlock(`Observaciones ${title}`, issuesList.join(' · ')) : '',
    recommendation ? reportTextBlock(`Recomendación ${title}`, recommendation) : ''
  ].filter(Boolean).join('');

  return `
    <div class="supervisor-card-section report-row-block">
      <h5 class="report-row-block-title">${escHtml(title)}</h5>
      ${facts}
      ${narratives}
    </div>
  `;
}

function renderReportRow(report) {
  const title = report.contact_name || `Conversación ${report.conversation_id}`;
  const score = formatReportScore(report);
  const architectNames = asList(report.architect_names).join(', ') || 'sin nombre identificado';
  const aiAgentBlock = participantSectionReport(
    'AI Agent',
    report.ai_agent_present,
    report.ai_agent_score,
    report.ai_agent_summary,
    report.ai_agent_issues,
    report.ai_agent_recommendation,
    `Mensajes salientes AI: ${report.ai_agent_outbound_count || 0}`
  );
  const architectBlock = participantSectionReport(
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

  const detailBlocks = [
    salesProcessSectionReport(report),
    aiAgentBlock,
    architectBlock,
    `<div class="report-row-recommendation"><strong>Recomendación:</strong> ${escHtml(report.recommendation || '—')}</div>`,
    `<div class="report-row-actions">
      <button type="button" class="btn btn-secondary btn-sm btn-report-reanalyze" data-conversation-id="${escAttr(String(report.conversation_id))}" onclick="reanalyzeReportFullHistory(${Number(report.conversation_id)})" title="Trae todos los mensajes de Chatwoot y actualiza este reporte">
        Reanalizar historial completo
      </button>
      ${url}
    </div>`
  ].join('');

  const detailsHtml = detailBlocks.trim()
    ? `<details class="report-row-details">
        <summary class="report-row-summary-toggle">
          <span class="report-row-toggle-closed">Ver análisis completo</span>
          <span class="report-row-toggle-open">Ocultar detalle</span>
        </summary>
        <div class="report-row-details-inner">
          ${detailBlocks}
        </div>
      </details>`
    : '';

  return `
    <article class="report-row">
      <header class="report-row-header">
        <div>
          <h4 class="report-row-title">${escHtml(title)}</h4>
          <div class="report-row-meta">${escHtml(analyzed)} · Score ${escHtml(score)} · Conv. ${escHtml(String(report.conversation_id))}</div>
        </div>
        <div class="report-row-badges">
          ${stageBadge(report.stage)}
          ${cotizacionEnviadaBadge(report)}
          ${inactiveInterestBadge(report)}
          ${riskBadge(report.risk_level)}
        </div>
      </header>
      <div class="report-row-body">
        <p class="report-row-lead">${escHtml(report.summary || 'Sin resumen.')}</p>
        ${formatAlertsBlock(report)}
        ${detailsHtml}
      </div>
    </article>
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
    const hideFuera = isReportsHideFueraAlcanceEnabled();
    const fueraNote = hideFuera
      ? '<br>Los reportes <strong>fuera de alcance</strong> están ocultos. Desmarca el filtro para verlos.'
      : '';
    content.innerHTML = `
      <div class="reports-empty">
        No hay reportes para <strong>${escHtml(branchLabel)}</strong> con <strong>${escHtml(riskLabel)}</strong>.
        <br>Ejecuta un análisis en la pestaña Supervisor AI o amplía la cantidad cargada.${fueraNote}
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
          <div class="reports-list">
            ${section.reports.map(r => renderReportRow(r)).join('')}
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

function buildReanalyzePayload(report) {
  const fieldValue = id => document.getElementById(id)?.value?.trim() || '';
  const baseUrl = fieldValue('cw-url').replace(/\/$/, '');
  const token = fieldValue('cw-token');
  const accountId = fieldValue('cw-account') || String(report.chatwoot_account_id || '');
  const inboxId = report.inbox_id != null ? String(report.inbox_id) : fieldValue('cw-branch');
  const branchName =
    report.branch_name ||
    BRANCH_NAME_BY_ID[inboxId] ||
    BRANCH_NAME_BY_ID[fieldValue('cw-branch')] ||
    '';
  return {
    baseUrl,
    token,
    accountId,
    conversationId: report.conversation_id,
    inboxId,
    branchName,
    contactName: report.contact_name || '',
    contactPhone: report.contact_phone || '',
    fullHistory: true,
    forceAnalyze: true
  };
}

function setReportReanalyzeBusy(conversationId, busy) {
  document.querySelectorAll(`.btn-report-reanalyze[data-conversation-id="${conversationId}"]`).forEach(btn => {
    btn.disabled = busy;
    btn.textContent = busy ? 'Analizando…' : 'Reanalizar historial completo';
  });
}

async function reanalyzeReportFullHistory(conversationId) {
  const report = reportsTabRaw.find(r => Number(r.conversation_id) === Number(conversationId));
  if (!report) {
    showError('No se encontró el reporte en la lista actual.');
    return;
  }
  if (reportReanalyzeInFlight.has(conversationId)) return;

  hideError();
  const payload = buildReanalyzePayload(report);
  if (!payload.accountId) {
    showError('Falta accountId: configura Chatwoot en Supervisor AI o guarda chatwoot_account_id en el reporte.');
    return;
  }

  reportReanalyzeInFlight.add(conversationId);
  setReportReanalyzeBusy(conversationId, true);
  const label = report.contact_name || `#${conversationId}`;
  showStatus(`Reanalizando historial completo de ${label}…`);

  try {
    const data = await supervisorApi('/api/supervisor/analyze/conversation', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    if (data.report) {
      const idx = reportsTabRaw.findIndex(r => Number(r.conversation_id) === Number(conversationId));
      if (idx >= 0) reportsTabRaw[idx] = data.report;
      else reportsTabRaw.unshift(data.report);
      applyReportsSearch();
    }

    showStatus(
      `Historial completo analizado para ${label}: ${data.messages_fetched ?? '—'} mensajes · guardado ${data.stored ? 'sí' : 'no'}`
    );
  } catch (err) {
    showError('Error al reanalizar: ' + err.message);
    console.error(err);
    hideStatus();
  } finally {
    reportReanalyzeInFlight.delete(conversationId);
    setReportReanalyzeBusy(conversationId, false);
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

  const stages = document.getElementById('followup-stages')?.value?.trim() || 'lead,asesor_venta';
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
      <td>${stageBadge(item.stage) || '—'}</td>
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
    const stages = document.getElementById('followup-stages')?.value?.trim() || 'lead,asesor_venta';
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

function normalizeStageKey(stage) {
  return String(stage || 'indefinida')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_');
}

function stageBadge(stage) {
  const key = normalizeStageKey(stage);
  const label = String(stage || 'indefinida').trim();
  if (key === 'fuera_de_alcance') {
    return `<span class="badge badge-stage-fuera" title="Esta versión solo evalúa lead y asesor_venta">fuera&nbsp;de&nbsp;alcance</span>`;
  }
  if (key === 'lead') {
    return `<span class="badge badge-gray">${escHtml(label)}</span>`;
  }
  if (key === 'asesor_venta' || key === 'asesor_ventas') {
    return `<span class="badge badge-green">${escHtml(label)}</span>`;
  }
  return `<span class="badge badge-gray">${escHtml(label)}</span>`;
}

function formatReportScore(report) {
  const raw = report?.raw_analysis;
  let scope = null;
  if (raw && typeof raw === 'object') scope = raw.evaluation_scope;
  else if (typeof raw === 'string') {
    try {
      scope = JSON.parse(raw).evaluation_scope;
    } catch {
      scope = null;
    }
  }
  if (normalizeStageKey(report?.stage) === 'fuera_de_alcance' || scope === 'fuera_de_alcance') {
    return 'no aplica';
  }
  return report?.score_general == null ? '—' : String(report.score_general);
}

function asList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function cotizacionEnviadaFromReport(report) {
  const sp = salesProcessFromReport(report);
  const qd = quoteDetectionFromReport(report);
  const urlConfirmed = Boolean(
    qd?.cotizacion_enviada || sp?.cotizacion_detection_source === 'url_pattern'
  );
  const cotizacionEnviada = urlConfirmed || Boolean(sp?.cotizacion_enviada);
  return { cotizacionEnviada, urlConfirmed, sp, qd };
}

function cotizacionEnviadaBadge(report) {
  const { cotizacionEnviada, urlConfirmed, sp, qd } = cotizacionEnviadaFromReport(report);
  if (!cotizacionEnviada) return '';
  const domain = qd?.cotizacion_domain || sp?.cotizacion_url_domain || '';
  const domainNote = domain ? ` (${domain})` : '';
  const title = urlConfirmed
    ? `Cotización enviada${domainNote} · confirmada por URL oficial`
    : `Cotización enviada · detectada por inferencia del AI (sin URL oficial)`;
  const cls = urlConfirmed ? 'badge badge-cotizacion' : 'badge badge-cotizacion-inferida';
  const label = urlConfirmed ? 'Cotización enviada' : 'Cotización enviada · AI';
  return `<span class="${cls}" title="${escAttr(title)}">${escHtml(label)}</span>`;
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
  if (report?.metrics?.quote_detection) return report.metrics.quote_detection;
  const raw = report?.raw_analysis;
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw).quote_detection || null;
    } catch {
      return null;
    }
  }
  return raw.quote_detection || null;
}

function salesProcessSection(report) {
  const { cotizacionEnviada, urlConfirmed, sp, qd } = cotizacionEnviadaFromReport(report);

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

function formatAlertsBlock(report) {
  const list = Array.isArray(report.alerts) ? report.alerts.filter(Boolean) : [];
  if (!list.length) return '';
  return `<div class="supervisor-alerts">
    <span class="supervisor-alerts-label" title="Alertas detectadas por el supervisor">
      <span class="supervisor-alerts-icon" aria-hidden="true">⚠</span> Alertas:
    </span>
    <span class="supervisor-alerts-text">${escHtml(list.join(' · '))}</span>
  </div>`;
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
      const score = formatReportScore(report);
      const inactiveBadge = inactiveInterestBadge(report);
      const alerts = formatAlertsBlock(report);
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
              <div class="supervisor-card-meta">${escHtml(report.branch_name || '—')} · Score ${escHtml(score)}</div>
            </div>
            <div class="supervisor-card-badges">
              ${stageBadge(report.stage)}
              ${cotizacionEnviadaBadge(report)}
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
      if (i === 2 || i === pages - 1) html += '<span style="color:var(--text);padding:0 4px">…</span>';
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
  else if (tab === 'configuracion') switchAppTab('configuracion');
});
