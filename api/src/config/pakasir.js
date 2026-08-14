/**
 * Pakasir (https://app.pakasir.com) Payment Gateway Configuration
 * ---------------------------------------------------------------
 * - BASE_URL      : endpoint API Pakasir
 * - API_KEY       : Project API key (dari dashboard Pakasir)
 * - WEBHOOK_SECRET: shared secret untuk validasi signature webhook
 * - METHOD        : default payment method (qris)
 */

const axios = require('axios');

const PAKASIR_BASE_URL =
  process.env.PAKASIR_BASE_URL || 'https://app.pakasir.com/api';
const PAKASIR_API_KEY = process.env.PAKASIR_API_KEY;
const PAKASIR_WEBHOOK_SECRET = process.env.PAKASIR_WEBHOOK_SECRET;
const PAKASIR_DEFAULT_METHOD = process.env.PAKASIR_DEFAULT_METHOD || 'qris';
const PAKASIR_TIMEOUT_MS = Number(process.env.PAKASIR_TIMEOUT_MS) || 15000;

function assertPakasirConfig() {
  const missing = [];
  if (!PAKASIR_API_KEY) missing.push('PAKASIR_API_KEY');
  if (!PAKASIR_WEBHOOK_SECRET) missing.push('PAKASIR_WEBHOOK_SECRET');
  if (missing.length > 0) {
    throw new Error(
      `[pakasir.config] Missing required env vars: ${missing.join(', ')}`
    );
  }
}

// ============================
// Axios instance khusus Pakasir
// ============================
const pakasirClient = axios.create({
  baseURL: PAKASIR_BASE_URL,
  timeout: PAKASIR_TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
});

// ============================
// Create Transaction (POST /transactioncreate/:method)
// Body docs: https://app.pakasir.com/docs
// ============================
async function createTransaction({ method, orderId, amount }) {
  const url = `/transactioncreate/${method || PAKASIR_DEFAULT_METHOD}`;

  const payload = {
    project: PAKASIR_API_KEY,
    order_id: orderId,
    amount: Number(amount),
  };

  const { data } = await pakasirClient.post(url, payload);
  return data;
}

// ============================
// Verify Webhook Signature
// Pakasir convention (umumnya):
//   - Header `x-pakasir-signature` = HMAC-SHA256(secret, rawBody)
//   - Atau cek di body.payment_status === 'completed'
//
// SECURITY (patch 2026-08-13):
//   - Production WAJIB set PAKASIR_WEBHOOK_SECRET
//   - Kalau secret di-set tapi webhook gak kirim signature → REJECT
//   - Kalau secret gak di-set di production → ERROR (gak fallback ke true)
//
// Pakai constant-time compare untuk mencegah timing attack.
// ============================
function verifyWebhookSignature(rawBody, signatureHeader) {
  const crypto = require('crypto');

  // Mode development: secret tidak di-set → izinkan tanpa signature
  // TAPI harus eksplisit di-enable via ALLOW_INSECURE_WEBHOOK=true
  if (!PAKASIR_WEBHOOK_SECRET) {
    if (
      process.env.NODE_ENV === 'production' ||
      process.env.ALLOW_INSECURE_WEBHOOK !== 'true'
    ) {
      // Production tanpa secret = bahaya. Treat as invalid.
      console.error(
        '[pakasir] PAKASIR_WEBHOOK_SECRET not set! ' +
        'Webhook akan di-reject. Set secret di .env atau aktifkan ' +
        'ALLOW_INSECURE_WEBHOOK=true untuk development.'
      );
      return false;
    }
    console.warn(
      '[pakasir] ⚠ Insecure mode: webhook signature not verified. ' +
      'JANGAN gunakan di production!'
    );
    return true;
  }

  // Production mode: secret di-set, signature WAJIB ada
  if (!signatureHeader) {
    console.warn('[pakasir] Webhook tanpa signature header');
    return false;
  }

  // Normalize signature (beberapa provider pakai prefix 'sha256=')
  let normalizedSig = String(signatureHeader).trim();
  if (normalizedSig.startsWith('sha256=')) {
    normalizedSig = normalizedSig.slice(7);
  }

  const expected = crypto
    .createHmac('sha256', PAKASIR_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('hex');

  // constant-time compare untuk mencegah timing attack
  let sigBuf, expBuf;
  try {
    sigBuf = Buffer.from(normalizedSig, 'hex');
    expBuf = Buffer.from(expected, 'hex');
  } catch (e) {
    return false; // invalid hex
  }

  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

module.exports = {
  pakasirClient,
  PAKASIR_BASE_URL,
  PAKASIR_API_KEY,
  PAKASIR_DEFAULT_METHOD,
  createTransaction,
  verifyWebhookSignature,
  assertPakasirConfig,
};
