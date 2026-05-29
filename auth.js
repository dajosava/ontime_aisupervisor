/**
 * Autenticación Supabase (navegador): sesión, fetch con JWT y protección de rutas.
 */
(function initOntimeAuth(global) {
  let supabaseClient = null;
  let config = null;

  async function loadConfig() {
    if (config) return config;
    const response = await fetch('/api/auth/config');
    if (!response.ok) {
      throw new Error('No se pudo cargar la configuración de autenticación.');
    }
    config = await response.json();
    return config;
  }

  async function getClient() {
    const cfg = await loadConfig();
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
      return null;
    }
    if (!supabaseClient && global.supabase) {
      supabaseClient = global.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true
        }
      });
    }
    return supabaseClient;
  }

  async function getSession() {
    if (!config?.authRequired) return null;
    const client = await getClient();
    if (!client) return null;
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    return data.session;
  }

  function isLoginPage() {
    const path = global.location.pathname || '';
    return path === '/login.html' || path === '/login';
  }

  async function requireAuth() {
    const cfg = await loadConfig();
    if (!cfg.authRequired) {
      document.body?.classList.remove('auth-pending');
      return true;
    }

    if (!cfg.authClientReady) {
      if (!isLoginPage()) {
        global.location.replace('/login.html');
        return false;
      }
      document.body?.classList.remove('auth-pending');
      return false;
    }

    const session = await getSession();
    if (!session) {
      if (!isLoginPage()) {
        const next = encodeURIComponent(global.location.pathname + global.location.search);
        global.location.replace(`/login.html?next=${next}`);
      }
      return false;
    }

    document.body?.classList.remove('auth-pending');
    return true;
  }

  async function authFetch(url, options = {}) {
    const cfg = await loadConfig();
    const headers = { ...(options.headers || {}) };

    if (cfg.authRequired) {
      const session = await getSession();
      if (!session?.access_token) {
        await requireAuth();
        throw new Error('Sesión no válida.');
      }
      headers.Authorization = `Bearer ${session.access_token}`;
    }

    return fetch(url, { ...options, headers });
  }

  async function signOut() {
    const client = await getClient();
    if (client) {
      await client.auth.signOut();
    }
    global.location.href = '/login.html';
  }

  function mountUserBar() {
    const slot = document.getElementById('auth-user-bar');
    if (!slot) return;

    getSession()
      .then(session => {
        if (!session?.user) {
          slot.hidden = true;
          return;
        }
        const email = session.user.email || 'Usuario';
        slot.hidden = false;
        slot.innerHTML = `
          <span class="auth-user-email" title="${escapeHtml(email)}">${escapeHtml(email)}</span>
          <button type="button" class="btn btn-secondary btn-sm auth-logout-btn" id="btn-auth-logout">Salir</button>
        `;
        document.getElementById('btn-auth-logout')?.addEventListener('click', () => signOut());
      })
      .catch(() => {
        slot.hidden = true;
      });
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  global.OntimeAuth = {
    loadConfig,
    getClient,
    getSession,
    requireAuth,
    authFetch,
    signOut,
    mountUserBar
  };
})(window);
