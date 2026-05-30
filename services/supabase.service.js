const { createClient } = require('@supabase/supabase-js');

const SUPABASE_REPORTS_TABLE = process.env.SUPABASE_REPORTS_TABLE || 'conversation_supervision_reports';
const SUPABASE_SNAPSHOTS_TABLE = process.env.SUPABASE_SNAPSHOTS_TABLE || 'conversation_followup_snapshots';

const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY || '').trim();
const AUTH_EXPLICITLY_OFF = process.env.AUTH_REQUIRED === 'false';
const AUTH_REQUIRED = !AUTH_EXPLICITLY_OFF && Boolean(process.env.SUPABASE_URL);
const AUTH_CLIENT_READY = AUTH_REQUIRED && Boolean(SUPABASE_ANON_KEY);

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false }
    })
    : null;

function isConfigured() {
  return Boolean(supabase);
}

function getBearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  if (!header.startsWith('Bearer ')) return '';
  return header.slice(7).trim();
}

async function verifySupabaseUser(req) {
  if (!AUTH_REQUIRED) return { ok: true, user: null };
  if (!AUTH_CLIENT_READY) {
    return {
      ok: false,
      status: 503,
      error: 'Falta SUPABASE_ANON_KEY en el servidor. Configura .env y reinicia.'
    };
  }
  const token = getBearerToken(req);
  if (!token) {
    return { ok: false, status: 401, error: 'Falta token de sesión. Inicia sesión.' };
  }
  if (!supabase) {
    return { ok: false, status: 503, error: 'Supabase no está configurado en el servidor.' };
  }
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return { ok: false, status: 401, error: 'Sesión inválida o expirada. Vuelve a iniciar sesión.' };
  }
  return { ok: true, user: data.user };
}

async function fetchPreviousReport(conversationId) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from(SUPABASE_REPORTS_TABLE)
    .select('*')
    .eq('conversation_id', Number(conversationId))
    .maybeSingle();
  if (error) throw new Error(`Supabase report previo: ${error.message}`);
  return data || null;
}

async function storeReports(rows) {
  if (!supabase) return { stored: false, count: 0 };
  const { error } = await supabase
    .from(SUPABASE_REPORTS_TABLE)
    .upsert(rows, { onConflict: 'conversation_id' });
  if (error) throw new Error(`Supabase: ${error.message}`);
  return { stored: true, count: rows.length };
}

async function fetchSnapshotHistory(conversationId, limit = 14) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from(SUPABASE_SNAPSHOTS_TABLE)
    .select('*')
    .eq('conversation_id', Number(conversationId))
    .order('snapshot_date', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Supabase snapshots histórico: ${error.message}`);
  return (data || []).reverse();
}

async function fetchReportsForFollowup({ inboxId, stages, limit }) {
  if (!supabase) throw new Error('Supabase no está configurado.');
  let query = supabase
    .from(SUPABASE_REPORTS_TABLE)
    .select('*')
    .in('stage', stages)
    .order('analyzed_at', { ascending: false })
    .limit(limit);

  if (inboxId) query = query.eq('inbox_id', Number(inboxId));

  const { data, error } = await query;
  if (error) throw new Error(`Supabase: ${error.message}`);
  return data || [];
}

async function fetchSnapshotsByDate(conversationIds, dates) {
  if (!supabase || !conversationIds.length) return [];
  const { data, error } = await supabase
    .from(SUPABASE_SNAPSHOTS_TABLE)
    .select('*')
    .in('conversation_id', conversationIds)
    .in('snapshot_date', dates);

  if (error) throw new Error(`Supabase snapshots: ${error.message}`);
  return data || [];
}

async function storeSnapshots(rows) {
  if (!supabase || !rows.length) return { stored: false, count: 0 };
  const { error } = await supabase
    .from(SUPABASE_SNAPSHOTS_TABLE)
    .upsert(rows, { onConflict: 'conversation_id,snapshot_date' });
  if (error) throw new Error(`Supabase snapshots: ${error.message}`);
  return { stored: true, count: rows.length };
}

async function listReports({ limit, filters = {} }) {
  if (!supabase) throw new Error('Supabase no está configurado.');
  let query = supabase
    .from(SUPABASE_REPORTS_TABLE)
    .select('*')
    .order('analyzed_at', { ascending: false })
    .limit(limit);

  for (const [column, value] of Object.entries(filters)) {
    if (value) query = query.eq(column, value);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Supabase: ${error.message}`);
  return data || [];
}

function getAuthConfig() {
  return {
    AUTH_REQUIRED,
    AUTH_CLIENT_READY,
    SUPABASE_ANON_KEY,
    supabaseUrl: AUTH_REQUIRED ? process.env.SUPABASE_URL || '' : ''
  };
}

module.exports = {
  supabase,
  SUPABASE_REPORTS_TABLE,
  SUPABASE_SNAPSHOTS_TABLE,
  isConfigured,
  getAuthConfig,
  getBearerToken,
  verifySupabaseUser,
  fetchPreviousReport,
  storeReports,
  fetchSnapshotHistory,
  fetchReportsForFollowup,
  fetchSnapshotsByDate,
  storeSnapshots,
  listReports
};
