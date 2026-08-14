/**
 * Supabase Client Configuration
 * --------------------------------
 * - createClient (serviceRole)   : untuk backend logic (bypass RLS)
 * - createUserClient (anonKey)  : untuk verify JWT user (forward request)
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

// ============================
// Validasi env di startup
// ============================
function assertSupabaseConfig() {
  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_ANON_KEY) missing.push('SUPABASE_ANON_KEY');
  if (!SUPABASE_JWT_SECRET) missing.push('SUPABASE_JWT_SECRET');

  if (missing.length > 0) {
    throw new Error(
      `[supabase.config] Missing required env vars: ${missing.join(', ')}`
    );
  }
}

// ============================
// WebSocket polyfill untuk Node.js < 22
// Supabase realtime butuh ini di Node 20
// ============================
if (typeof WebSocket === 'undefined') {
  global.WebSocket = require('ws');
}

// ============================
// 1. Service-role client (TRUSTED)
//    Bypass RLS. Dipakai untuk write ke wallets/transactions.
// ============================
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// ============================
// 2. User-scoped client (forward request user JWT)
//    Untuk operasi RLS-scoped (read own data, dll).
// ============================
function getUserClient(accessToken) {
  if (!accessToken) {
    throw new Error('[supabase] getUserClient requires an access token');
  }
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    auth: { persistSession: false },
  });
}

module.exports = {
  supabaseAdmin,
  getUserClient,
  assertSupabaseConfig,
};
