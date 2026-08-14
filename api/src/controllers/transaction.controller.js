/**
 * Transaction Controller
 * ---------------------------------------------------------------
 * Handle HTTP request/response untuk transaction endpoints.
 * Business logic didelegasikan ke transaction.service.js
 *
 * ====================================================================
 * SISTEM FINAL (PENTING — BACA INI!)
 * ====================================================================
 *
 *   PAKASIR HANYA UNTUK TOP UP SALDO. TITIK.
 *
 *   PAKASIR = payment gateway untuk TERIMA UANG dari user.
 *   Saat user top up, Pakasir menerima pembayaran → kirim webhook
 *   ke server kita → server update database (saldo user +).
 *   UANG FISIK ada di akun Pakasir Anda, BUKAN di sistem kita.
 *
 *   BELI TOKEN / SUBSCRIPTION = POTONG SALDO INTERNAL, GAK LEWAT PAKASIR.
 *   Kenapa? Karena user SUDAH top up saldo sebelumnya.
 *   Saldo di database = "uang virtual" yang merepresentasikan uang
 *   yang sudah dibayar user ke Pakasir. Saat user beli token/subscription,
 *   kita tinggal potong saldo di database (gak ada transfer uang).
 *
 *   3 JENIS PRODUK:
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ 1. topup         → PAKASIR QRIS (user bayar ke Pakasir)     │
 *   │                     Saldo user di database nambah            │
 *   │                     UANG FISIK: nambah di akun Pakasir Anda │
 *   │                                                             │
 *   │ 2. token_purchase → POTONG SALDO INTERNAL (no Pakasir)      │
 *   │                     Saldo -X, token +X/500                  │
 *   │                     Gak ada transfer uang                   │
 *   │                                                             │
 *   │ 3. subscription  → POTONG SALDO INTERNAL (no Pakasir)       │
 *   │                     Saldo -X, tier=basic/pro/premium        │
 *   │                     Gak ada transfer uang                   │
 *   └─────────────────────────────────────────────────────────────┘
 *
 *   JAMINAN: Uang Anda di Pakasir AMAN.
 *   - Sistem kita TIDAK pernah call API "transfer dana keluar"
 *   - Sistem kita hanya call: createTransaction (minta QR) +
 *     cek status (Cuma baca, gak ngubah saldo Pakasir)
 *   - Withdraw dana dari Pakasir: manual via dashboard Pakasir
 *
 *   User flow:
 *   1. User top up 50K via Pakasir → saldo +50.000
 *   2. User "Beli Token" 10K → saldo -10.000, token +20
 *   3. ATAU "Subscribe" Basic 15K → saldo -15.000, tier=basic
 *   4. Build APK → token -1 (kalau free trial) / unlimited (kalau sub)
 * ====================================================================
 */

const { createTransaction } = require('../config/pakasir');
const { supabaseAdmin } = require('../config/supabase');
const {
  createTransactionRecord,
  getTransactionByOrderId,
  markTransactionCompleted,
  applyTransactionToWallet,
  purchaseTokensWithSaldo,
  activateSubscription,
} = require('../services/transaction.service');
const { AppError } = require('../middlewares/errorHandler');

/**
 * POST /api/transactions/create
 * Body:
 *   - type: 'topup' | 'token_purchase' | 'subscription'
 *   - amount_idr: number (untuk topup & token_purchase)
 *   - target_tier?: 'basic' | 'pro' | 'premium' (untuk subscription)
 *   - description?: string
 *
 * SISTEM BARU — TIDAK ADA kind:
 *   - type='topup' → user top up uang, saldo masuk
 *   - type='token_purchase' → user pilih nominal saldo, jadi token
 *   - type='subscription' → user pilih tier, jadi langganan
 *
 * Flow:
 *   1. Validasi user
 *   2. Insert transaction pending ke Supabase
 *   3. Hit API Pakasir untuk QR
 *   4. Return ke frontend
 *
 *   Khusus token_purchase & subscription: bayar pakai SALDO
 *   (instant, no QRIS — saldo langsung dipotong).
 *   User harus top up dulu kalau saldo kurang.
 */
async function createTransactionHandler(req, res, next) {
  try {
    const { type, amount_idr, target_tier, description } = req.body;
    const userId = req.user.id;

    // ============== Validasi input ==============
    if (!type) {
      throw new AppError('Field "type" is required', 400, 'MISSING_FIELD');
    }
    if (!['topup', 'token_purchase', 'subscription'].includes(type)) {
      throw new AppError(
        `Invalid type. Allowed: topup, token_purchase, subscription`,
        400,
        'INVALID_TYPE'
      );
    }

    // ============== ROUTING BY TYPE ==============
    if (type === 'topup') {
      return await handleTopup({ req, res, userId, amount_idr, description });
    }
    if (type === 'token_purchase') {
      return await handleTokenPurchase({ req, res, userId, amount_idr, description });
    }
    if (type === 'subscription') {
      return await handleSubscription({ req, res, userId, target_tier, description });
    }
  } catch (err) {
    return next(err);
  }
}

/**
 * TOPUP — user top up saldo via QRIS
 * amount_idr: nominal yang mau di-topup
 */
async function handleTopup({ req, res, userId, amount_idr, description }) {
  const amountIdr = Number(amount_idr);
  if (!amountIdr || amountIdr < 500) {
    throw new AppError(
      'Minimum top-up is Rp 500',
      400,
      'AMOUNT_TOO_LOW'
    );
  }

  // Generate order_id
  const { data: uuidRow } = await supabaseAdmin.rpc('gen_random_uuid');
  const orderId = uuidRow || require('crypto').randomUUID();

  // Insert transaction pending
  // token_amount=0 karena topup cuma nambah saldo, bukan token
  const { transaction } = await createTransactionRecord({
    userId,
    type: 'topup',
    amountIdr,
    tokenAmount: 0,
    referenceId: orderId,
    description: description || `Top up saldo ${amountIdr.toLocaleString('id-ID')}`,
    metadata: {
      method: 'qris',
      requested_at: new Date().toISOString(),
    },
  });

  // Hit API Pakasir
  const pakasirResponse = await pakasirOrFail({ transaction, orderId, amountIdr });

  return res.status(201).json({
    success: true,
    data: {
      transaction_id: transaction.id,
      order_id: orderId,
      type: 'topup',
      amount_idr: amountIdr,
      payment: pakasirResponse,
      instructions: 'Selesaikan pembayaran QRIS. Saldo akan otomatis masuk setelah webhook diterima.',
    },
  });
}

/**
 * TOKEN PURCHASE — user beli token pakai saldo (INSTANT, no QRIS)
 * amount_idr: berapa saldo yang mau ditukar jadi token
 *
 * Flow:
 *   1. Cek saldo user >= amount_idr
 *   2. Potong saldo (SQL atomic)
 *   3. Tambah token (SQL atomic, dalam transaksi yang sama)
 *   4. Catat transaction 'token_purchase' success
 *   5. Return saldo + token baru
 */
async function handleTokenPurchase({ req, res, userId, amount_idr, description }) {
  const amountIdr = Number(amount_idr);
  if (!amountIdr || amountIdr < 500) {
    throw new AppError(
      'Minimum token purchase is Rp 500',
      400,
      'AMOUNT_TOO_LOW'
    );
  }
  if (amountIdr % 500 !== 0) {
    throw new AppError(
      'Amount harus kelipatan Rp 500 (1 token = Rp 500)',
      400,
      'INVALID_MULTIPLE'
    );
  }

  // Cek saldo user dulu
  const { data: wallet } = await supabaseAdmin
    .from('wallets')
    .select('id, balance_idr')
    .eq('user_id', userId)
    .single();

  if (!wallet) {
    throw new AppError('Wallet not found', 404, 'WALLET_NOT_FOUND');
  }
  if (Number(wallet.balance_idr) < amountIdr) {
    throw new AppError(
      `Saldo tidak cukup. Anda punya ${Number(wallet.balance_idr).toLocaleString('id-ID')}, butuh ${amountIdr.toLocaleString('id-ID')}. Top up dulu.`,
      402,
      'INSUFFICIENT_BALANCE',
      { current_balance: wallet.balance_idr, required: amountIdr }
    );
  }

  // Execute atomic purchase
  try {
    const result = await purchaseTokensWithSaldo({
      userId,
      walletId: wallet.id,
      amountIdr,
      description: description || `Beli ${amountIdr / 500} token pakai saldo`,
    });

    return res.json({
      success: true,
      message: `Berhasil beli ${result.tokensAdded} token (potong saldo ${amountIdr.toLocaleString('id-ID')})`,
      data: result,
    });
  } catch (err) {
    throw new AppError(
      `Token purchase failed: ${err.message}`,
      500,
      'PURCHASE_FAILED'
    );
  }
}

/**
 * SUBSCRIPTION — user bayar subscription pakai saldo (INSTANT, no QRIS)
 * target_tier: 'basic' | 'pro' | 'premium'
 *
 * Flow:
 *   1. Ambil harga tier
 *   2. Cek saldo user >= harga
 *   3. Potong saldo
 *   4. Set tier + expiry date
 *   5. Catat transaction 'subscription' success
 */
async function handleSubscription({ req, res, userId, target_tier, description }) {
  if (!target_tier) {
    throw new AppError(
      'Field "target_tier" is required for subscription',
      400,
      'MISSING_FIELD'
    );
  }

  const tierPriceMap = {
    basic: Number(process.env.PRICING_BASIC_IDR) || 15000,
    pro: Number(process.env.PRICING_PRO_IDR) || 30000,
    premium: Number(process.env.PRICING_PREMIUM_IDR) || 60000,
  };
  const tierPrice = tierPriceMap[target_tier];
  if (!tierPrice) {
    throw new AppError(`Unknown tier: ${target_tier}`, 400, 'INVALID_TIER');
  }

  // Cek saldo
  const { data: wallet } = await supabaseAdmin
    .from('wallets')
    .select('id, balance_idr, subscription_tier')
    .eq('user_id', userId)
    .single();

  if (!wallet) {
    throw new AppError('Wallet not found', 404, 'WALLET_NOT_FOUND');
  }
  if (Number(wallet.balance_idr) < tierPrice) {
    throw new AppError(
      `Saldo tidak cukup untuk subscription ${target_tier}. Anda punya ${Number(wallet.balance_idr).toLocaleString('id-ID')}, butuh ${tierPrice.toLocaleString('id-ID')}.`,
      402,
      'INSUFFICIENT_BALANCE',
      { current_balance: wallet.balance_idr, required: tierPrice, tier: target_tier }
    );
  }

  // Execute atomic activation
  try {
    const result = await activateSubscription({
      userId,
      walletId: wallet.id,
      targetTier: target_tier,
      amountIdr: tierPrice,
      description: description || `Subscription ${target_tier} (potong saldo)`,
    });

    return res.json({
      success: true,
      message: `Berlangganan ${target_tier.toUpperCase()} aktif sampai ${result.expires_at}`,
      data: result,
    });
  } catch (err) {
    throw new AppError(
      `Subscription activation failed: ${err.message}`,
      500,
      'SUBSCRIPTION_FAILED'
    );
  }
}

/**
 * Helper: Hit Pakasir atau rollback transaction
 */
async function pakasirOrFail({ transaction, orderId, amountIdr }) {
  let pakasirResponse;
  try {
    pakasirResponse = await createTransaction({
      method: 'qris',
      orderId,
      amount: amountIdr,
    });
  } catch (err) {
    // Rollback
    await supabaseAdmin
      .from('transactions')
      .update({ status: 'failed' })
      .eq('id', transaction.id);
    const upstream = err.response?.data;
    throw new AppError(
      `Pakasir error: ${upstream?.message || err.message}`,
      502,
      'PAYMENT_GATEWAY_ERROR'
    );
  }

  // Simpan payment_id ke metadata
  await supabaseAdmin
    .from('transactions')
    .update({
      metadata: {
        ...transaction.metadata,
        pakasir_payment_id: pakasirResponse?.payment_id || null,
        pakasir_fee: pakasirResponse?.fee || null,
        pakasir_total: pakasirResponse?.total_payment || null,
      },
    })
    .eq('id', transaction.id);

  return {
    method: 'qris',
    payment_id: pakasirResponse?.payment_id,
    qr_string: pakasirResponse?.qr_string || pakasirResponse?.qr_url,
    qr_url: pakasirResponse?.qr_url,
    expired_at: pakasirResponse?.expired_at,
    total_payment: pakasirResponse?.total_payment,
  };
}

/**
 * GET /api/transactions/:orderId
 * Frontend bisa polling status transaksi setelah bayar (topup only).
 * Untuk token_purchase & subscription, langsung return success (instant).
 */
async function getTransactionStatusHandler(req, res, next) {
  try {
    const { orderId } = req.params;
    const tx = await getTransactionByOrderId(orderId);

    if (!tx) {
      throw new AppError('Transaction not found', 404, 'NOT_FOUND');
    }
    if (tx.user_id !== req.user.id) {
      throw new AppError('Forbidden', 403, 'FORBIDDEN');
    }

    return res.json({
      success: true,
      data: {
        order_id: tx.reference_id,
        type: tx.type,
        status: tx.status,
        amount_idr: tx.amount_idr,
        created_at: tx.created_at,
        updated_at: tx.updated_at,
      },
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * =============================================
 * GET /api/wallet/history
 * Riwayat semua transaksi user
 * =============================================
 */
async function walletHistoryHandler(req, res, next) {
  try {
    const userId = req.user.id;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    const typeFilter = req.query.type;

    let query = supabaseAdmin
      .from('transactions')
      .select(`
        id, type, status, amount_idr, token_amount,
        balance_after_idr, token_after, reference_id, description, metadata,
        created_at, updated_at
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (typeFilter) {
      query = query.eq('type', typeFilter);
    }

    const { data: transactions, error } = await query;

    if (error) {
      throw new AppError(`Failed to fetch: ${error.message}`, 500, 'DB_QUERY_FAILED');
    }

    const allTx = transactions || [];
    const summary = {
      total_count: allTx.length,
      total_topup_idr: allTx
        .filter(t => t.type === 'topup' && t.status === 'success')
        .reduce((sum, t) => sum + Number(t.amount_idr || 0), 0),
      total_token_purchase_idr: allTx
        .filter(t => t.type === 'token_purchase' && t.status === 'success')
        .reduce((sum, t) => sum + Number(t.amount_idr || 0), 0),
      total_token_used: allTx
        .filter(t => t.type === 'build' && t.status === 'success')
        .reduce((sum, t) => sum + Math.abs(Number(t.token_amount || 0)), 0),
      total_subscription_idr: allTx
        .filter(t => t.type === 'subscription' && t.status === 'success')
        .reduce((sum, t) => sum + Number(t.amount_idr || 0), 0),
      total_refund_idr: allTx
        .filter(t => t.type === 'refund' && t.status === 'success')
        .reduce((sum, t) => sum + Math.abs(Number(t.amount_idr || 0)), 0),
    };

    return res.json({
      success: true,
      data: {
        transactions: allTx,
        summary,
        pagination: {
          limit,
          offset,
          has_more: allTx.length === limit,
        },
      },
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  createTransactionHandler,
  getTransactionStatusHandler,
  walletHistoryHandler,
  // NOTE: convertToTokensHandler sudah DIHAPUS.
  // Sistem baru: token = PRODUK yang dibeli pakai saldo (token_purchase).
  // Tidak ada convert manual saldo → token.
  _mc: markTransactionCompleted,
  _aw: applyTransactionToWallet,
};
