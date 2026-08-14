/**
 * API Routes
 * ---------------------------------------------------------------
 * Mount ke /api di server.js
 *
 *   POST   /api/transactions/create    (auth)
 *   GET    /api/transactions/:orderId  (auth)
 *   POST   /api/webhook/pakasir        (publik, signature)
 *   POST   /api/build                  (auth) - trigger build APK
 *   GET    /api/build/:jobId           (auth) - cek status
 *   GET    /api/build                  (auth) - history build user
 *   GET    /api/preview                (publik) - proxy preview HTML
 *   GET    /api/captcha/generate       (publik) - get CAPTCHA code
 *   POST   /api/captcha/verify         (publik) - verify CAPTCHA
 */

const express = require('express');
const router = express.Router();

const { requireAuth } = require('../middlewares/auth.middleware');
const {
  createTransactionHandler,
  getTransactionStatusHandler,
  walletHistoryHandler,
} = require('../controllers/transaction.controller');
// Note: convertToTokensHandler sudah DIHAPUS.
// Sistem baru: token = PRODUK yang dibeli pakai saldo (token_purchase).
// Tidak ada convert manual saldo → token.
const { pakasirWebhookHandler } = require('../controllers/webhook.controller');
const {
  createBuildHandler,
  getBuildStatusHandler,
  listBuildsHandler,
} = require('../controllers/build.controller');
const { previewProxyHandler } = require('../controllers/preview.controller');
const {
  generateCaptchaHandler,
  verifyCaptchaHandler,
} = require('../controllers/captcha.controller');
const {
  checkExpiredSubscriptionsHandler,
  expirePendingTransactionsHandler,
  reconcileWalletsHandler,
  reconcilePendingPaymentsHandler,
} = require('../controllers/cron.controller');

/**
 * Health check (publik)
 */
router.get('/health', (req, res) => {
  res.json({ success: true, status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * ====================
 * PREVIEW PROXY (publik)
 * ====================
 * GET /api/preview?url=https://example.com
 * Returns HTML untuk embed di iframe, bypass X-Frame-Options.
 */
router.get('/preview', previewProxyHandler);

/**
 * ====================
 * TRANSACTION ROUTES
 * ====================
 *
 * Sistem baru (3 jenis produk):
 *   POST /transactions/create type='topup'         → Top up saldo (via QRIS)
 *   POST /transactions/create type='token_purchase' → Beli token (potong saldo, instant)
 *   POST /transactions/create type='subscription'  → Subscribe (potong saldo, instant)
 *   GET  /transactions/:orderId                    → Cek status topup
 *   GET  /wallet/history                           → Riwayat semua transaksi
 */
router.post('/transactions/create', requireAuth, createTransactionHandler);
router.get('/transactions/:orderId', requireAuth, getTransactionStatusHandler);

// Get wallet history (riwayat transaksi, real-time)
router.get('/wallet/history', requireAuth, walletHistoryHandler);

/**
 * ====================
 * AUTH ROUTES
 * ====================
 * Logout endpoint: destroy session di server (cookie + Redis).
 * PENTING: harus di-call supaya session Express `wb2.sid` benar-benar
 * mati. Supabase client-side signOut() cuma hapus token Supabase,
 * tapi session server masih hidup 24 jam kalau endpoint ini gak dipanggil.
 *
 * Endpoint publik (no requireAuth): kalau session gak ada, return ok aja.
 */
router.post('/auth/logout', (req, res) => {
  if (!req.session) {
    return res.json({ success: true, message: 'No active session' });
  }
  req.session.destroy((err) => {
    if (err) {
      console.error('[auth/logout] session destroy error:', err);
      return res.status(500).json({
        success: false,
        error: 'LOGOUT_FAILED',
        message: 'Gagal destroy session',
      });
    }
    // Clear cookie di browser
    res.clearCookie('wb2.sid', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    });
    res.json({ success: true, message: 'Logout berhasil' });
  });
});

/**
 * ====================
 * CAPTCHA ROUTES (publik)
 * ====================
 *
 * CAPTCHA server-side (anti-bot) untuk form signup & login.
 *   GET  /api/captcha/generate  → { code, expires_at }
 *   POST /api/captcha/verify   → { valid: true } | 401
 */
router.get('/captcha/generate', generateCaptchaHandler);
router.post('/captcha/verify', verifyCaptchaHandler);

/**
 * ====================
 * CRON ROUTES (scheduled jobs)
 * ====================
 * Semua endpoint pakai auth: x-cron-secret header atau ?secret=...
 *
 * Schedule yang direkomendasikan (lihat panduan_vps.md):
 *   setiap 5 menit   =>  expire-pending-transactions
 *   setiap 30 menit  =>  reconcile-pending-payments
 *   jam 01:00        =>  check-expired-subscriptions
 *   jam 01:05        =>  reconcile-wallets
 */
router.post('/cron/check-expired-subscriptions', checkExpiredSubscriptionsHandler);
router.post('/cron/expire-pending-transactions', expirePendingTransactionsHandler);
router.post('/cron/reconcile-wallets', reconcileWalletsHandler);
router.post('/cron/reconcile-pending-payments', reconcilePendingPaymentsHandler);

/**
 * ====================
 * BUILD ROUTES (Tahap 3)
 * ====================
 */
router.post('/build', requireAuth, createBuildHandler);
router.get('/build/:jobId', requireAuth, getBuildStatusHandler);
router.get('/build', requireAuth, listBuildsHandler);

/**
 * ====================
 * WEBHOOK ROUTES (publik)
 * ====================
 * PENTING: Webhook pakai express.raw() untuk preserve body as-is,
 * supaya HMAC signature verification bisa pakai raw body yang PERSIS
 * sama dengan yang dikirim Pakasir. Kalau pakai express.json(),
 * property ordering bisa berubah setelah JSON.stringify(req.body)
 * ulang → signature selalu invalid.
 *
 * Flow di controller:
 *   - req.body = Buffer (raw)
 *   - rawBody = req.body.toString('utf8') untuk HMAC
 *   - JSON.parse(rawBody) untuk dapat payload
 */
router.post(
  '/webhook/pakasir',
  express.raw({ type: 'application/json', limit: '1mb' }),
  pakasirWebhookHandler
);

module.exports = router;
