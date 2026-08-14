/**
 * Cron Controller
 * ---------------------------------------------------------------
 * Endpoint untuk scheduled jobs (jalankan via cron di VPS).
 *
 * Daftar cron jobs:
 *
 * 1. POST /api/cron/check-expired-subscriptions
 *    - Schedule: 1x sehari (recommended: jam 00:01 WIB)
 *    - Auto-downgrade subscription yang expired
 *
 * 2. POST /api/cron/expire-pending-transactions
 *    - Schedule: 1x per 5 menit
 *    - Mark transaction pending > 15 menit jadi 'expired'
 *
 * 3. POST /api/cron/reconcile-wallets
 *    - Schedule: 1x sehari (setelah #1)
 *    - Auto-fix corrupted wallet data (self-healing)
 *
 * 4. POST /api/cron/reconcile-pending-payments
 *    - Schedule: 1x per 30 menit
 *    - Detect tx 'success' yang efeknya gak masuk ke wallet
 *      (webhook received tapi apply gagal)
 *
 * Cron setup di VPS:
 *   crontab -e
 *   (tiap 5 menit)     curl -X POST -H "x-cron-secret: $CRON_SECRET" https://yourdomain.com/api/cron/expire-pending-transactions
 *   (tiap 30 menit)    curl -X POST -H "x-cron-secret: $CRON_SECRET" https://yourdomain.com/api/cron/reconcile-pending-payments
 *   (jam 01:00)        curl -X POST -H "x-cron-secret: $CRON_SECRET" https://yourdomain.com/api/cron/check-expired-subscriptions
 *   (jam 01:05)        curl -X POST -H "x-cron-secret: $CRON_SECRET" https://yourdomain.com/api/cron/reconcile-wallets
 *
 * Format crontab (lihat panduan_vps.md untuk setup lengkap):
 *   setiap 5 menit   => "asterisk-slash-5 spasi asterisk spasi asterisk spasi asterisk spasi asterisk"
 *   setiap 30 menit  => "asterisk-slash-30 spasi ..."
 *   jam 1 pagi       => "0 1 asterisk asterisk asterisk"
 *   jam 1:05 pagi    => "5 1 asterisk asterisk asterisk"
 */

const { supabaseAdmin } = require('../config/supabase');
const {
  checkAllExpiredSubscriptions,
  reconcileWallet,
  reconcilePendingPayments,
} = require('../services/wallet.service');
const { expirePendingTransactions } = require('../services/transaction.service');
const { AppError } = require('../middlewares/errorHandler');

/**
 * Simple auth: pakai shared secret di header
 * Untuk production, pakai Bearer token atau IP whitelist
 */
function checkCronAuth(req) {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  const expectedSecret = process.env.CRON_SECRET || 'web2app-cron-default-secret';
  return secret === expectedSecret;
}

/**
 * POST /api/cron/check-expired-subscriptions
 * Schedule: 1x sehari (jam 00:01 WIB)
 */
async function checkExpiredSubscriptionsHandler(req, res, next) {
  try {
    if (!checkCronAuth(req)) {
      throw new AppError('Unauthorized cron call', 401, 'CRON_UNAUTHORIZED');
    }

    const result = await checkAllExpiredSubscriptions();

    return res.json({
      success: true,
      message: 'Subscription expiry check completed',
      data: result,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/cron/expire-pending-transactions
 * Schedule: 1x per 5 menit
 *
 * Mark transaction pending yang lebih dari 15 menit jadi 'expired'.
 * Mencegah DB kotor dan membantu reconciliation.
 */
async function expirePendingTransactionsHandler(req, res, next) {
  try {
    if (!checkCronAuth(req)) {
      throw new AppError('Unauthorized cron call', 401, 'CRON_UNAUTHORIZED');
    }

    const result = await expirePendingTransactions();

    return res.json({
      success: true,
      message: 'Pending transactions expiry check completed',
      data: result,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/cron/reconcile-wallets
 * Schedule: 1x sehari (setelah check-expired)
 *
 * Scan SEMUA user, fix corrupted wallet data.
 * Note: ini bisa lambat kalau user banyak (>10k). Untuk production
 * dengan user banyak, pertimbangkan incremental reconciliation.
 */
async function reconcileWalletsHandler(req, res, next) {
  try {
    if (!checkCronAuth(req)) {
      throw new AppError('Unauthorized cron call', 401, 'CRON_UNAUTHORIZED');
    }

    // Pagination: ambil user 1000 per batch
    let page = 1;
    const perPage = 1000;
    let checked = 0;
    let fixed = 0;
    const issues = [];

    while (true) {
      const { data: users, error } = await supabaseAdmin.auth.admin.listUsers({
        page,
        perPage,
      });

      if (error) {
        throw new AppError(
          `Failed to list users: ${error.message}`,
          500,
          'ADMIN_LIST_FAILED'
        );
      }

      const userList = users?.users || [];
      if (userList.length === 0) break;

      for (const user of userList) {
        checked++;
        try {
          const result = await reconcileWallet(user.id);
          if (result.fixed) {
            fixed++;
            issues.push({ user_id: user.id, changes: result.changes });
          }
        } catch (e) {
          console.error(`[cron.reconcile] User ${user.id} failed:`, e.message);
          issues.push({ user_id: user.id, error: e.message });
        }
      }

      if (userList.length < perPage) break;
      page++;
    }

    return res.json({
      success: true,
      message: 'Wallet reconciliation completed',
      data: { checked, fixed, issues: issues.slice(0, 100) },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/cron/reconcile-pending-payments
 * Schedule: 1x per 30 menit
 *
 * Detect transaksi 'success' yang wallet effect-nya gak ke-apply.
 * Ini terjadi kalau webhook received tapi applyTransactionToWallet gagal.
 *
 * Untuk saat ini: hanya DETECT + LOG (action_taken='manual_required').
 * Future: bisa tambah auto-apply ulang kalau aman.
 */
async function reconcilePendingPaymentsHandler(req, res, next) {
  try {
    if (!checkCronAuth(req)) {
      throw new AppError('Unauthorized cron call', 401, 'CRON_UNAUTHORIZED');
    }

    const result = await reconcilePendingPayments();

    return res.json({
      success: true,
      message: 'Pending payments reconciliation completed',
      data: result,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  checkExpiredSubscriptionsHandler,
  expirePendingTransactionsHandler,
  reconcileWalletsHandler,
  reconcilePendingPaymentsHandler,
};
