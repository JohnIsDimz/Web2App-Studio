/**
 * Transaction Service
 * ---------------------------------------------------------------
 * Business logic untuk tabel `transactions` dan `wallets`.
 *
 * SISTEM FINAL (3 PRODUK):
 *   1. topup          → Tambah saldo (user top up uang via QRIS)
 *   2. token_purchase → Beli token pakai saldo (potong saldo, instant)
 *   3. subscription   → Berlangganan pakai saldo (potong saldo, instant)
 *
 *   Token dan Subscription adalah 2 PRODUK TERPISAH.
 *   TIDAK ADA convert manual.
 *   Build APK: potong token (kalau ada) — pakai quota (kalau langganan).
 *
 * Method public:
 *   - createTransactionRecord(input)        → simpan row pending (untuk topup)
 *   - markTransactionCompleted(id)          → webhook handler (topup only)
 *   - applyTransactionToWallet(tx)          → SQL atomic apply (topup, subscription via webhook)
 *   - purchaseTokensWithSaldo(input)        → atomic: potong saldo + tambah token
 *   - activateSubscription(input)           → atomic: potong saldo + set tier
 *   - getTransactionByOrderId(orderId)
 *   - expirePendingTransactions()           → cron job (15 min)
 *
 * TIDAK ada komunikasi HTTP di sini. HTTP layer (controller) yang
 * memanggil service.
 */

const { supabaseAdmin } = require('../config/supabase');
const { AppError } = require('../middlewares/errorHandler');

// =============================================
// Tipe transaksi & efeknya ke wallet
// =============================================
// PENTING: Ini hanya untuk VALIDASI input dan DECISION routing.
// EFEK KE WALLET 100% di-handle oleh SQL function atomic.
// =============================================
const TRANSACTION_EFFECTS = {
  topup: {
    // Tambah saldo (user top up uang)
    affectsBalance: true,
    sqlFunction: 'apply_topup_to_wallet',
    via_webhook: true, // Pakasir webhook
  },
  token_purchase: {
    // Beli token pakai saldo (instant, no QRIS)
    affectsBalance: true,
    affectsToken: true,
    sqlFunction: 'purchase_tokens_with_saldo',
    via_webhook: false, // Direct, no QRIS
  },
  subscription: {
    // Subscribe pakai saldo (instant, no QRIS)
    affectsBalance: true,
    affectsSubscription: true,
    sqlFunction: 'activate_subscription_with_saldo',
    via_webhook: false,
  },
  build: {
    // Potong token (kalau free trial) atau pakai quota (kalau langganan)
    affectsToken: true,
    sqlFunction: 'deduct_token_for_build',
  },
  refund: {
    // Refund token (kalau build gagal)
    affectsToken: true,
    sqlFunction: null, // manual via admin tool
  },
  bonus: {
    // Bonus signup (3 token, idempotent)
    affectsToken: true,
    sqlFunction: 'credit_bonus_tokens',
  },
};

// Tier configuration
const TIER_CONFIG = {
  none:     { quotaLimit: 0,    isVip: false, durationDays: 0 },
  basic:    { quotaLimit: 35,   isVip: false, durationDays: 30 },
  pro:      { quotaLimit: 0,    isVip: false, durationDays: 30 },
  premium:  { quotaLimit: 0,    isVip: true,  durationDays: 30 },
};

const TOKEN_PRICE_IDR = Number(process.env.TOKEN_PRICE_IDR) || 500;
const PENDING_EXPIRY_MINUTES = Number(process.env.PENDING_EXPIRY_MINUTES) || 15;

// =============================================
// DATE HELPERS
// =============================================
function addOneMonth(date) {
  const d = new Date(date);
  const targetMonth = d.getMonth() + 1;
  const targetYear = d.getFullYear();
  const targetDay = d.getDate();

  const result = new Date(targetYear, targetMonth, 1);
  const lastDayOfTargetMonth = new Date(targetYear, targetMonth + 1, 0).getDate();

  const finalDay = Math.min(targetDay, lastDayOfTargetMonth);
  result.setDate(finalDay);

  return result;
}

// =============================================
// 1. Create transaction record (status: pending)
//    Digunakan untuk TOPUP (perlu webhook dari Pakasir)
//    Token_purchase & subscription TIDAK pakai ini (langsung instant)
// =============================================
async function createTransactionRecord({
  userId,
  type,
  amountIdr,
  tokenAmount = 0,
  referenceId,
  description,
  metadata = {},
}) {
  const effect = TRANSACTION_EFFECTS[type];
  if (!effect) {
    throw new AppError(`Invalid transaction type: ${type}`, 400, 'INVALID_TYPE');
  }

  // Ambil wallet user
  const { data: wallet, error: wErr } = await supabaseAdmin
    .from('wallets')
    .select('id, balance_idr, token_balance, subscription_tier')
    .eq('user_id', userId)
    .single();

  if (wErr || !wallet) {
    throw new AppError('Wallet not found for user', 404, 'WALLET_NOT_FOUND');
  }

  // Anti-spam: duplicate pending dalam 1 menit
  if (type === 'topup' || type === 'subscription') {
    const oneMinAgo = new Date(Date.now() - 60 * 1000).toISOString();
    const { data: recentDup } = await supabaseAdmin
      .from('transactions')
      .select('id, reference_id, created_at')
      .eq('user_id', userId)
      .eq('type', type)
      .eq('amount_idr', amountIdr)
      .eq('status', 'pending')
      .gte('created_at', oneMinAgo)
      .limit(1);

    if (recentDup && recentDup.length > 0) {
      throw new AppError(
        'Duplicate pending transaction detected. Selesaikan atau tunggu transaksi sebelumnya expired.',
        429,
        'DUPLICATE_PENDING',
        { existing_order_id: recentDup[0].reference_id }
      );
    }
  }

  const { data: tx, error: txErr } = await supabaseAdmin
    .from('transactions')
    .insert({
      user_id: userId,
      wallet_id: wallet.id,
      type,
      status: 'pending',
      amount_idr: amountIdr,
      token_amount: tokenAmount,
      reference_id: referenceId,
      description: description || null,
      metadata,
    })
    .select()
    .single();

  if (txErr) {
    if (txErr.code === '23505' && txErr.message?.includes('reference_id')) {
      throw new AppError(
        'Order ID sudah ada.',
        409,
        'DUPLICATE_REFERENCE_ID'
      );
    }
    throw new AppError(
      `Failed to create transaction: ${txErr.message}`,
      500,
      'DB_INSERT_FAILED'
    );
  }

  return { transaction: tx, wallet };
}

// =============================================
// 2. Get transaction by reference_id
// =============================================
async function getTransactionByOrderId(orderId) {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('*')
    .eq('reference_id', orderId)
    .maybeSingle();
  if (error) {
    console.error('[transaction] getTransactionByOrderId error:', error);
    return null;
  }
  return data;
}

// =============================================
// 3. Mark transaction as completed (idempotent)
//    Dipanggil oleh webhook handler
// =============================================
async function markTransactionCompleted(transactionId) {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .update({
      status: 'success',
      updated_at: new Date().toISOString(),
    })
    .eq('id', transactionId)
    .eq('status', 'pending')
    .select()
    .maybeSingle();

  if (error) {
    throw new AppError(
      `Failed to mark transaction complete: ${error.message}`,
      500,
      'DB_UPDATE_FAILED'
    );
  }
  return data;
}

// =============================================
// 4. Apply transaction effect to wallet (via SQL function)
//    Dipanggil webhook handler setelah mark completed
// =============================================
async function applyTransactionToWallet(transaction) {
  const effect = TRANSACTION_EFFECTS[transaction.type];
  if (!effect) {
    throw new AppError(
      `Unknown transaction type: ${transaction.type}`,
      400,
      'INVALID_TYPE'
    );
  }

  if (transaction.status !== 'success') {
    throw new AppError(
      `Transaction status must be 'success', got '${transaction.status}'`,
      400,
      'INVALID_STATUS'
    );
  }

  // Hanya topup & subscription yang lewat webhook
  if (transaction.type === 'topup') {
    const { data, error } = await supabaseAdmin.rpc('apply_topup_to_wallet', {
      p_transaction_id: transaction.id,
    });

    if (error) {
      console.error('[applyTransaction] topup failed:', error);
      throw new AppError(`Apply topup failed: ${error.message}`, 500, 'APPLY_FAILED');
    }

    if (!data || data.length === 0) {
      throw new AppError('No result from apply_topup_to_wallet', 500, 'NO_RESULT');
    }

    const result = data[0];
    return {
      walletId: transaction.wallet_id,
      alreadyApplied: result.already_applied,
      balanceAfter: Number(result.balance_after),
      tokenAfter: Number(result.token_after),
      method: 'sql_atomic',
    };
  }

  if (transaction.type === 'subscription') {
    const { data, error } = await supabaseAdmin.rpc('apply_subscription_to_wallet', {
      p_transaction_id: transaction.id,
    });

    if (error) {
      console.error('[applyTransaction] subscription failed:', error);
      throw new AppError(`Apply subscription failed: ${error.message}`, 500, 'APPLY_FAILED');
    }

    if (!data || data.length === 0) {
      throw new AppError('No result from apply_subscription_to_wallet', 500, 'NO_RESULT');
    }

    const result = data[0];
    return {
      walletId: transaction.wallet_id,
      alreadyApplied: result.already_applied,
      tier: result.tier,
      expiresAt: result.expires_at,
      method: 'sql_atomic',
    };
  }

  throw new AppError(
    `Transaction type '${transaction.type}' tidak di-apply via webhook.`,
    400,
    'NOT_WEBHOOK_APPLIED'
  );
}

// =============================================
// 5. ROLLBACK
// =============================================
async function revertTransaction(transactionId) {
  await supabaseAdmin
    .from('transactions')
    .update({ status: 'failed' })
    .eq('id', transactionId);
}

// =============================================
// 6. PURCHASE TOKENS WITH SALDO (INSTANT)
// =============================================
/**
 * User beli token pakai saldo. Atomic: potong saldo + tambah token.
 * Rate: 1 token = Rp 500 (TOKEN_PRICE_IDR)
 *
 * @param {object} input
 * @param {string} input.userId
 * @param {string} input.walletId
 * @param {number} input.amountIdr  // saldo yang dibayar
 * @param {string} input.description
 *
 * @returns {Promise<{balanceBefore, balanceAfter, tokensBefore, tokensAfter, tokensAdded, transaction_id}>}
 */
async function purchaseTokensWithSaldo({ userId, walletId, amountIdr, description }) {
  // Validasi
  if (!userId || !walletId || !amountIdr) {
    throw new AppError('Missing required fields', 400, 'MISSING_FIELDS');
  }
  if (amountIdr <= 0) {
    throw new AppError('Amount must be > 0', 400, 'INVALID_AMOUNT');
  }
  if (amountIdr % TOKEN_PRICE_IDR !== 0) {
    throw new AppError(
      `Amount harus kelipatan Rp ${TOKEN_PRICE_IDR} (1 token = Rp ${TOKEN_PRICE_IDR})`,
      400,
      'INVALID_MULTIPLE'
    );
  }

  // Pakai SQL function atomic (akan kita buat: purchase_tokens_with_saldo)
  const { data, error } = await supabaseAdmin.rpc('purchase_tokens_with_saldo', {
    p_user_id: userId,
    p_wallet_id: walletId,
    p_amount_idr: amountIdr,
    p_description: description || `Beli ${amountIdr / TOKEN_PRICE_IDR} token`,
  });

  if (error) {
    if (error.message?.includes('INSUFFICIENT_BALANCE')) {
      throw new AppError('Saldo tidak cukup', 402, 'INSUFFICIENT_BALANCE');
    }
    console.error('[purchaseTokens] SQL error:', error);
    throw new AppError(`Purchase failed: ${error.message}`, 500, 'PURCHASE_FAILED');
  }

  if (!data || data.length === 0) {
    throw new AppError('No result from purchase_tokens_with_saldo', 500, 'NO_RESULT');
  }

  const r = data[0];
  return {
    balanceBefore: Number(r.balance_before),
    balanceAfter: Number(r.balance_after),
    tokensBefore: Number(r.tokens_before),
    tokensAfter: Number(r.tokens_after),
    tokensAdded: Number(r.tokens_added),
    transactionId: r.transaction_id,
    rate: `1 token = Rp ${TOKEN_PRICE_IDR}`,
  };
}

// =============================================
// 7. ACTIVATE SUBSCRIPTION WITH SALDO (INSTANT)
// =============================================
/**
 * User subscribe pakai saldo. Atomic: potong saldo + set tier + expiry.
 *
 * @param {object} input
 * @param {string} input.userId
 * @param {string} input.walletId
 * @param {string} input.targetTier  // 'basic' | 'pro' | 'premium'
 * @param {number} input.amountIdr   // harga tier (untuk audit)
 * @param {string} input.description
 *
 * @returns {Promise<{balanceBefore, balanceAfter, tier, expires_at, transaction_id}>}
 */
async function activateSubscription({ userId, walletId, targetTier, amountIdr, description }) {
  if (!userId || !walletId || !targetTier) {
    throw new AppError('Missing required fields', 400, 'MISSING_FIELDS');
  }
  if (!TIER_CONFIG[targetTier] || targetTier === 'none') {
    throw new AppError(`Invalid tier: ${targetTier}`, 400, 'INVALID_TIER');
  }

  // Pakai SQL function atomic
  const { data, error } = await supabaseAdmin.rpc('activate_subscription_with_saldo', {
    p_user_id: userId,
    p_wallet_id: walletId,
    p_target_tier: targetTier,
    p_amount_idr: amountIdr,
    p_description: description || `Subscription ${targetTier}`,
  });

  if (error) {
    if (error.message?.includes('INSUFFICIENT_BALANCE')) {
      throw new AppError('Saldo tidak cukup untuk subscription', 402, 'INSUFFICIENT_BALANCE');
    }
    if (error.message?.includes('INVALID_TIER')) {
      throw new AppError('Tier tidak valid', 400, 'INVALID_TIER');
    }
    console.error('[activateSubscription] SQL error:', error);
    throw new AppError(`Activation failed: ${error.message}`, 500, 'ACTIVATION_FAILED');
  }

  if (!data || data.length === 0) {
    throw new AppError('No result from activate_subscription_with_saldo', 500, 'NO_RESULT');
  }

  const r = data[0];
  return {
    balanceBefore: Number(r.balance_before),
    balanceAfter: Number(r.balance_after),
    tier: r.tier,
    expiresAt: r.expires_at,
    transactionId: r.transaction_id,
  };
}

// =============================================
// 8. Expire pending transactions (cron)
// =============================================
async function expirePendingTransactions() {
  const cutoff = new Date(
    Date.now() - PENDING_EXPIRY_MINUTES * 60 * 1000
  ).toISOString();

  const { data: expired, error } = await supabaseAdmin
    .from('transactions')
    .update({
      status: 'expired',
      metadata_note: `Auto-expired by cron (older than ${PENDING_EXPIRY_MINUTES} minutes)`,
      updated_at: new Date().toISOString(),
    })
    .eq('status', 'pending')
    .lt('created_at', cutoff)
    .select('id, created_at');

  if (error) {
    console.error('[expirePending] Error:', error.message);
    throw new AppError(
      `Failed to expire pending transactions: ${error.message}`,
      500,
      'DB_UPDATE_FAILED'
    );
  }

  const { data: oldest } = await supabaseAdmin
    .from('transactions')
    .select('created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  const oldestAge = oldest
    ? Math.floor((Date.now() - new Date(oldest.created_at).getTime()) / 60000)
    : 0;

  console.log(
    `[expirePending] Expired ${expired?.length || 0} pending transactions. ` +
    `Oldest remaining pending: ${oldestAge} minutes.`
  );

  return {
    expired_count: expired?.length || 0,
    oldest_pending_age_minutes: oldestAge,
    cutoff_iso: cutoff,
  };
}

module.exports = {
  createTransactionRecord,
  getTransactionByOrderId,
  markTransactionCompleted,
  applyTransactionToWallet,
  revertTransaction,
  expirePendingTransactions,
  // BARU: untuk token_purchase & subscription (instant, pakai saldo)
  purchaseTokensWithSaldo,
  activateSubscription,
  TIER_CONFIG,
  TOKEN_PRICE_IDR,
  PENDING_EXPIRY_MINUTES,
};
