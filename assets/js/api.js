/**
 * Web2App Studio - API Client
 * ============================================
 * Fetch wrapper untuk semua endpoint backend.
 * Config: otomatis pakai API_BASE_URL dari auth.js.
 */

// =============================================
// [CONFIG] SUPABASE CONFIG
// =============================================
const SUPABASE_URL = window.SUPABASE_URL || 'https://iajcbbrnyidblbonxryk.supabase.co';
const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhamNiYnJueWlkYmxib254cnlrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY1NTM0NzksImV4cCI6MjEwMjEyOTQ3OX0.8gyGmBS9_Fx4o4W1Uzm2X8zpFUgcK2XRgcbKV5wH_hs';

// Expose ke global
window.SUPABASE_URL = SUPABASE_URL;
window.SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;

const API_BASE_URL = window.API_BASE_URL || `${window.location.origin}/api`;

/**
 * Ambil access token dari Supabase session (cached, sync)
 */
function getAccessToken() {
  if (!window.supabase?.auth?.session) {
    return null;
  }
  const session = window.supabase.auth.session();
  return session?.access_token || null;
}

/**
 * Generic fetch wrapper dengan auth otomatis
 */
async function apiRequest(path, options = {}) {
  const url = `${API_BASE_URL}${path}`;
  const token = getAccessToken();

  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const res = await fetch(url, {
      ...options,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const error = new Error(
        data.message || data.error || `HTTP ${res.status}`
      );
      error.status = res.status;
      error.code = data.error;
      error.details = data.details;
      throw error;
    }

    return data;
  } catch (err) {
    console.error('[api] failed:', url, err.message);
    throw err;
  }
}

// =============================================
// User
// =============================================
async function getMe() {
  const token = getAccessToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
    };
  } catch {
    return null;
  }
}

async function getMyWallet() {
  if (window.Web2AppAuth?.getMyWallet) {
    return window.Web2AppAuth.getMyWallet();
  }
  return null;
}

// =============================================
// Transactions (Top-up / Token / Subscription)
// =============================================
async function createTransaction(payload) {
  return apiRequest('/transactions/create', { method: 'POST', body: payload });
}

async function getTransactionStatus(orderId) {
  return apiRequest(`/transactions/${orderId}`);
}

// Beli token pakai saldo (instant, no QRIS)
async function buyTokensWithSaldo({ amount }) {
  return createTransaction({
    type: 'token_purchase',
    amount_idr: amount,
  });
}

// Beli subscription pakai saldo (instant, no QRIS)
async function buySubscriptionWithSaldo({ tier }) {
  return createTransaction({
    type: 'subscription',
    target_tier: tier,
  });
}

// =============================================
// Build APK
// =============================================
async function createBuild(payload) {
  return apiRequest('/build', { method: 'POST', body: payload });
}

async function getBuildStatus(jobId) {
  return apiRequest(`/build/${jobId}`);
}

async function listBuilds({ limit = 20, offset = 0 } = {}) {
  return apiRequest(`/build?limit=${limit}&offset=${offset}`);
}

// =============================================
// Wallet History (Real-time)
// =============================================
async function getWalletHistory({ limit = 50, offset = 0, type = null } = {}) {
  const params = new URLSearchParams();
  if (limit) params.set('limit', limit);
  if (offset) params.set('offset', offset);
  if (type) params.set('type', type);
  return apiRequest(`/wallet/history?${params.toString()}`);
}

window.Web2AppAPI = {
  apiRequest,
  getAccessToken,
  getMe,
  getMyWallet,
  createTransaction,
  getTransactionStatus,
  createBuild,
  getBuildStatus,
  listBuilds,
  buyTokensWithSaldo,
  buySubscriptionWithSaldo,
  getWalletHistory,
};
