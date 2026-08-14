/**
 * Web2App Studio - Auth Helper (Supabase)
 * ============================================
 * Simplified Supabase Auth integration.
 *
 * SETUP SUPER SIMPEL:
 *   1. Buka https://supabase.com/dashboard
 *   2. Buat project baru (free)
 *   3. Copy URL + Anon Key dari Settings → API
 *   4. Paste di CONFIG di bawah (cukup 2 baris!)
 *   5. Jalankan schema SQL di SQL Editor
 *   6. Done! Login/signup dengan email & password jalan.
 *
 * Backend (.env) pakai key yang sama persis.
 */

// =============================================
// [CONFIG] CONFIG - SUDAH DIISI DENGAN KREDENSIAL ANDA
// =============================================
// Supabase project: iajcbbrnyidblbonxryk.supabase.co
const SUPABASE_URL = 'https://iajcbbrnyidblbonxryk.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhamNiYnJueWlkYmxib254cnlrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY1NTM0NzksImV4cCI6MjEwMjEyOTQ3OX0.8gyGmBS9_Fx4o4W1Uzm2X8zpFUgcK2XRgcbKV5wH_hs';

// API Backend URL (ganti saat deploy ke production)
const API_BASE_URL =
  window.location.hostname === 'localhost'
    ? 'http://localhost:3000/api'
    : `${window.location.origin}/api`;

// Expose global
window.SUPABASE_URL = SUPABASE_URL;
window.SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;
window.API_BASE_URL = API_BASE_URL;

// =============================================
// Init Supabase Client
// =============================================
function initSupabase() {
  // Cek library Supabase loaded
  if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
    showSetupError(
      'Supabase library belum di-load. ' +
        'Tambah: <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>'
    );
    return null;
  }

  // Cek config sudah diisi
  if (SUPABASE_URL.includes('YOUR_') || SUPABASE_ANON_KEY.includes('YOUR_')) {
    showSetupError(
      '<span data-icon="alert-triangle" class="h-5 w-5"></span>️ Supabase config belum diisi!\n\n' +
        'Edit file assets/js/auth.js dan ganti:\n' +
        '  SUPABASE_URL = "https://your-project.supabase.co"\n' +
        '  SUPABASE_ANON_KEY = "eyJ..."\n\n' +
        'Dapatkan dari: https://supabase.com/dashboard/project/_/settings/api'
    );
    return null;
  }

  // Hanya init kalau belum ada
  if (window.supabase.auth && window.supabase.auth.getSession) {
    return window.supabase;
  }

  // Create client
  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storage: window.localStorage,
    },
  });

  window.supabase = client;
  return client;
}

function showSetupError(message) {
  console.error('[auth]', message);
  // Tampilkan error di UI kalau ada
  if (document.body) {
    const banner = document.createElement('div');
    banner.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
      background: #DC2626; color: white; padding: 16px;
      font-family: monospace; font-size: 14px; white-space: pre-wrap;
      border-bottom: 4px solid black;
    `;
    banner.textContent = message;
    document.body.prepend(banner);
  }
}

// =============================================
// [AUTH] Auth Functions (semua pakai Supabase API)
// =============================================

/** Sign up dengan email + password */
async function signUp({ email, password, fullName }) {
  const client = initSupabase();
  if (!client) throw new Error('Supabase belum dikonfigurasi');

  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName },
      // Skip email confirmation kalau di-disable di Supabase settings
      emailRedirectTo: window.location.origin + '/dashboard.html',
    },
  });
  if (error) throw error;
  return data;
}

/** Sign in dengan email + password */
async function signIn({ email, password }) {
  const client = initSupabase();
  if (!client) throw new Error('Supabase belum dikonfigurasi');

  const { data, error } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
  return data;
}

/** Logout */
async function signOut() {
  const client = initSupabase();
  if (!client) return;

  // 1. Destroy session Express di server (cookie wb2.sid + Redis)
  //    Tanpa ini, session server masih hidup 24 jam walau Supabase token sudah clear.
  try {
    await fetch(`${API_BASE_URL}/auth/logout`, {
      method: 'POST',
      credentials: 'include',  // kirim cookie wb2.sid
    });
  } catch (e) {
    console.warn('[logout] backend session destroy failed:', e.message);
  }

  // 2. Sign out dari Supabase (hapus token di browser)
  await client.auth.signOut();

  // 3. Redirect ke login
  window.location.href = '/login.html';
}

/** Get current user */
function getCurrentUser() {
  const client = initSupabase();
  return client?.auth?.user?.() || null;
}

/** Get current session */
async function getSession() {
  const client = initSupabase();
  if (!client) return null;
  const { data: { session } } = await client.auth.getSession();
  return session;
}

/** Guard: redirect ke login kalau belum auth */
async function requireAuthGuard() {
  const session = await getSession();
  if (!session) {
    window.location.href = '/login.html';
    return null;
  }
  return session;
}

/**
 * Get wallet user dari Supabase (via RLS)
 * Dipakai oleh dashboard.js untuk display token/tier/quota
 */
async function getMyWallet() {
  const client = initSupabase();
  if (!client) return null;

  const { data: { user } } = await client.auth.getUser();
  if (!user) return null;

  const { data, error } = await client
    .from('wallets')
    .select('*')
    .eq('user_id', user.id)
    .single();

  if (error) {
    console.warn('[auth] wallet fetch failed:', error.message);
    return null;
  }
  return data;
}

// =============================================
// Expose ke window
// =============================================
window.Web2AppAuth = {
  // Init
  initSupabase,
  // Auth
  signUp,
  signIn,
  signOut,
  // Session helpers
  getCurrentUser,
  getSession,
  requireAuthGuard,
  // Data
  getMyWallet,
  // Config (read-only)
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  API_BASE_URL,
};
