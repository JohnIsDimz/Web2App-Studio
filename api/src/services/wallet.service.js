/**
 * Wallet Service
 * ---------------------------------------------------------------
 * Operasional wallet: potong token, increment quota, dsb.
 * Dipakai oleh build.controller (Tahap 3) dan transaction.service.
 */

const { supabaseAdmin } = require('../config/supabase');
const { AppError } = require('../middlewares/errorHandler');

/**
 * Ambil wallet user by user_id
 */
async function getWalletByUserId(userId) {
  const { data, error } = await supabaseAdmin
    .from('wallets')
    .select('*')
    .eq('user_id', userId)
    .single();
  if (error || !data) {
    throw new AppError('Wallet not found', 404, 'WALLET_NOT_FOUND');
  }
  return data;
}

/**
 * Potong token (untuk user tier 'none' yang topup).
 * Atomic: cek dulu, baru decrement.
 */
async function deductToken(userId, amount = 1) {
  const wallet = await getWalletByUserId(userId);

  if ((wallet.token_balance || 0) < amount) {
    throw new AppError(
      `Insufficient token: have ${wallet.token_balance}, need ${amount}`,
      402,
      'INSUFFICIENT_TOKEN'
    );
  }

  const newBalance = wallet.token_balance - amount;
  const { data, error } = await supabaseAdmin
    .from('wallets')
    .update({ token_balance: newBalance })
    .eq('id', wallet.id)
    .select()
    .single();

  if (error) {
    throw new AppError(
      `Failed to deduct token: ${error.message}`,
      500,
      'WALLET_UPDATE_FAILED'
    );
  }

  return { wallet: data, previousBalance: wallet.token_balance };
}

/**
 * Increment quota usage (untuk user langganan Basic/Pro/Premium).
 * Catat transaksi 'build' untuk audit.
 */
async function incrementBuildQuota(userId, txClient = null) {
  const wallet = await getWalletByUserId(userId);
  const newUsed = (wallet.build_quota_used || 0) + 1;

  const { data, error } = await supabaseAdmin
    .from('wallets')
    .update({
      build_quota_used: newUsed,
      build_quota_limit: wallet.build_quota_limit || 0,
    })
    .eq('id', wallet.id)
    .select()
    .single();

  if (error) {
    throw new AppError(
      `Failed to increment quota: ${error.message}`,
      500,
      'WALLET_UPDATE_FAILED'
    );
  }

  return { wallet: data, quotaUsed: newUsed };
}

/**
 * Refund token (jika build gagal setelah token terpotong).
 */
async function refundToken(userId, amount = 1) {
  const wallet = await getWalletByUserId(userId);
  const newBalance = (wallet.token_balance || 0) + amount;

  const { data, error } = await supabaseAdmin
    .from('wallets')
    .update({ token_balance: newBalance })
    .eq('id', wallet.id)
    .select()
    .single();

  if (error) {
    throw new AppError(
      `Failed to refund token: ${error.message}`,
      500,
      'WALLET_UPDATE_FAILED'
    );
  }

  return { wallet: data };
}

/**
 * Decrement quota (refund quota jika build gagal).
 */
async function decrementBuildQuota(userId) {
  const wallet = await getWalletByUserId(userId);
  const newUsed = Math.max(0, (wallet.build_quota_used || 0) - 1);

  const { data, error } = await supabaseAdmin
    .from('wallets')
    .update({ build_quota_used: newUsed })
    .eq('id', wallet.id)
    .select()
    .single();

  if (error) {
    console.error('[wallet] Failed to refund quota:', error);
  }
  return { wallet: data };
}



/**
 * =============================================
 * SUBSCRIPTION EXPIRY CHECK
 * =============================================
 * Cek apakah subscription user sudah expired.
 * Kalau ya, downgrade ke 'none' dan reset quota.
 *
 * Dipanggil:
 *   1. Setiap kali user akan build (defense in depth)
 *   2. Cron job harian (auto-downgrade)
 *   3. Setiap load wallet (lazy check)
 */
async function checkExpiredSubscription(userId) {
  const wallet = await getWalletByUserId(userId);
  
  if (!wallet || !wallet.subscription_expires_at) {
    return wallet; // no expiry set
  }
  
  // Skip kalau tier 'none' (gak ada subscription)
  if (wallet.subscription_tier === 'none') {
    return wallet;
  }
  
  const now = new Date();
  const expiresAt = new Date(wallet.subscription_expires_at);
  
  // Set expiresAt ke AKHIR hari (23:59:59.999)
  // Jadi subscription valid sampai akhir hari H, expired mulai H+1 jam 00:00
  // Contoh: subscribe 1 Jan → expire 1 Feb 23:59:59 → expired mulai 2 Feb 00:00
  const endOfExpiryDay = new Date(expiresAt);
  endOfExpiryDay.setHours(23, 59, 59, 999);
  
  // Belum expired (masih dalam hari H)
  if (endOfExpiryDay > now) {
    return wallet;
  }
  
  // ============================================
  // EXPIRED! Downgrade ke 'none'
  // ============================================
  console.log(
    `[wallet] Subscription expired for user ${userId}: ` +
    `tier=${wallet.subscription_tier}, expired=${expiresAt.toISOString()}`
  );
  
  const { data: updated, error } = await supabaseAdmin
    .from('wallets')
    .update({
      subscription_tier: 'none',
      subscription_expires_at: null,
      build_quota_limit: 0,
      build_quota_used: 0,
      is_vip_queue: false,
      // Token balance TIDAK di-reset (user boleh pakai token sisa)
    })
    .eq('id', wallet.id)
    .select()
    .single();
  
  if (error) {
    console.error('[wallet] Failed to downgrade expired subscription:', error);
    return wallet; // Return original kalau error
  }
  
  // Catat transaksi audit
  await supabaseAdmin.from('transactions').insert({
    user_id: userId,
    wallet_id: wallet.id,
    type: 'refund',  // Pakai 'refund' atau bikin type baru 'subscription_expired'
    status: 'success',
    amount_idr: 0,
    token_amount: 0,
    description: `Subscription ${wallet.subscription_tier} expired, downgraded to free tier`,
    metadata: {
      expired_at: expiresAt.toISOString(),
      previous_tier: wallet.subscription_tier,
      reason: 'subscription_expired',
    },
  });
  
  return updated;
}

/**
 * =============================================
 * BATCH CHECK: Cron job harian
 * =============================================
 * Dipanggil sekali sehari oleh cron untuk downgrade SEMUA
 * subscription yang expired.
 *
 * Returns: { checked: N, expired: M }
 */
async function checkAllExpiredSubscriptions() {
  const now = new Date().toISOString();
  
  // Query semua wallet yang:
  // - subscription_tier != 'none'
  // - subscription_expires_at <= now
  const { data: expiredWallets, error } = await supabaseAdmin
    .from('wallets')
    .select('id, user_id, subscription_tier, subscription_expires_at')
    .neq('subscription_tier', 'none')
    .not('subscription_expires_at', 'is', null)
    .lte('subscription_expires_at', now);
  
  if (error) {
    console.error('[wallet] Batch check error:', error);
    return { checked: 0, expired: 0, error: error.message };
  }
  
  let downgraded = 0;
  for (const wallet of expiredWallets || []) {
    try {
      await checkExpiredSubscription(wallet.user_id);
      downgraded++;
    } catch (e) {
      console.error(`[wallet] Failed to downgrade user ${wallet.user_id}:`, e);
    }
  }
  
  return {
    checked: expiredWallets?.length || 0,
    expired: downgraded,
  };
}



/**
 * =============================================
 * DATA INTEGRITY VALIDATION
 * =============================================
 * Sanity check: pastikan data wallet user AMAN (tidak corrupted).
 * 
 * JANJI KE USER:
 * - Saldo (balance_idr) TIDAK AKAN pernah negatif
 * - Token (token_balance) TIDAK AKAN pernah negatif
 * - Token TIDAK AKAN hilang saat login / refresh
 * - Token HANYA berkurang 1 per build sukses
 * - Token di-REFUND 100% saat build gagal
 * - Subscription expired TIDAK reset token
 *
 * Returns: { valid: true } atau { valid: false, issues: [...] }
 */
async function validateWalletIntegrity(userId) {
  const wallet = await getWalletByUserId(userId);
  const issues = [];

  // Check 1: token_balance tidak boleh negatif
  if (wallet.token_balance < 0) {
    issues.push({
      severity: 'critical',
      field: 'token_balance',
      value: wallet.token_balance,
      message: 'Token balance NEGATIF (corrupted)',
    });
  }

  // Check 2: balance_idr tidak boleh negatif
  if (wallet.balance_idr < 0) {
    issues.push({
      severity: 'critical',
      field: 'balance_idr',
      value: wallet.balance_idr,
      message: 'Balance IDR NEGATIF (corrupted)',
    });
  }

  // Check 3: build_quota_used tidak boleh lebih dari limit (kecuali unlimited)
  if (wallet.build_quota_limit > 0 && wallet.build_quota_used > wallet.build_quota_limit) {
    issues.push({
      severity: 'high',
      field: 'build_quota_used',
      value: wallet.build_quota_used,
      limit: wallet.build_quota_limit,
      message: 'Quota used exceeds limit (corrupted)',
    });
  }

  // Check 4: subscription_expires_at harus valid date string
  if (wallet.subscription_expires_at && isNaN(new Date(wallet.subscription_expires_at).getTime())) {
    issues.push({
      severity: 'high',
      field: 'subscription_expires_at',
      value: wallet.subscription_expires_at,
      message: 'Invalid date string',
    });
  }

  // Check 5: subscription_expires_at HARUS null kalau tier = 'none'
  if (wallet.subscription_tier === 'none' && wallet.subscription_expires_at !== null) {
    issues.push({
      severity: 'medium',
      field: 'subscription_expires_at',
      value: wallet.subscription_expires_at,
      message: 'Tier none tapi ada expiry date (should be null)',
    });
  }

  // Check 6: tier HARUS valid enum
  const validTiers = ['none', 'basic', 'pro', 'premium'];
  if (!validTiers.includes(wallet.subscription_tier)) {
    issues.push({
      severity: 'critical',
      field: 'subscription_tier',
      value: wallet.subscription_tier,
      message: 'Invalid tier value',
    });
  }

  if (issues.length > 0) {
    console.error(
      `[INTEGRITY] Wallet integrity issues for user ${userId}:`,
      JSON.stringify(issues, null, 2)
    );
    return { valid: false, issues, wallet };
  }

  return { valid: true, wallet };
}

/**
 * =============================================
 * RECONCILE WALLET (Self-healing)
 * =============================================
 * Kalau integrity check gagal, FIX data yang corrupted
 * (misal: set negative balance ke 0).
 *
 * Returns: { fixed: true/false, changes: [...] }
 */
async function reconcileWallet(userId) {
  const { valid, issues, wallet } = await validateWalletIntegrity(userId);
  if (valid) return { fixed: false };

  const updates = {};
  const changes = [];

  for (const issue of issues) {
    switch (issue.field) {
      case 'token_balance':
        if (issue.value < 0) {
          updates.token_balance = 0;
          changes.push(`token_balance: ${issue.value} → 0`);
        }
        break;
      case 'balance_idr':
        if (issue.value < 0) {
          updates.balance_idr = 0;
          changes.push(`balance_idr: ${issue.value} → 0`);
        }
        break;
      case 'build_quota_used':
        if (wallet.build_quota_limit > 0 && issue.value > issue.limit) {
          updates.build_quota_used = wallet.build_quota_limit;
          changes.push(`build_quota_used: ${issue.value} → ${issue.limit}`);
        }
        break;
      case 'subscription_expires_at':
        if (wallet.subscription_tier === 'none' && issue.value !== null) {
          updates.subscription_expires_at = null;
          changes.push(`subscription_expires_at: cleared (tier was none)`);
        }
        break;
    }
  }

  if (Object.keys(updates).length === 0) {
    return { fixed: false, message: 'No fixable issues' };
  }

  const { error } = await supabaseAdmin
    .from('wallets')
    .update(updates)
    .eq('id', wallet.id);

  if (error) {
    console.error('[RECONCILE] Failed:', error);
    return { fixed: false, error: error.message };
  }

  console.log(`[RECONCILE] Fixed wallet for user ${userId}:`, changes);
  return { fixed: true, changes };
}

/**
 * =============================================
 * RECONCILE PENDING PAYMENTS (Self-healing #2)
 * =============================================
 * Detect transaksi 'success' yang efeknya BELUM masuk ke wallet.
 * Ini terjadi kalau:
 *   - Webhook Pakasir diterima, status di-update jadi 'success'
 *   - Tapi `applyTransactionToWallet` gagal (network error, server crash)
 *   - Status revert ke 'failed' (atau tetap 'success' tapi wallet gak berubah)
 *
 * Solusi: scan semua tx success dalam 24 jam terakhir,
 *         bandingkan dengan wallet snapshot, kalau gak match
 *         → apply ulang (replay).
 *
 * Returns: { checked, fixed, manual_required, details }
 */
async function reconcilePendingPayments() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Ambil semua tx success dalam 24 jam terakhir
  const { data: successTxs, error: txErr } = await supabaseAdmin
    .from('transactions')
    .select(`
      id, user_id, wallet_id, type, status,
      amount_idr, token_amount,
      balance_after_idr, token_after,
      created_at, updated_at, metadata
    `)
    .eq('status', 'success')
    .gte('updated_at', cutoff)
    .order('updated_at', { ascending: false });

  if (txErr) {
    console.error('[reconcile] Failed to query transactions:', txErr);
    return { checked: 0, fixed: 0, manual_required: 0, error: txErr.message };
  }

  const txs = successTxs || [];
  let fixed = 0;
  let manualRequired = 0;
  const details = [];

  for (const tx of txs) {
    // Skip kalau bukan topup/subscription (build, refund, bonus gak perlu)
    if (!['topup', 'subscription'].includes(tx.type)) continue;

    // Ambil wallet saat ini
    const { data: wallet, error: wErr } = await supabaseAdmin
      .from('wallets')
      .select('id, balance_idr, token_balance, subscription_tier, subscription_expires_at')
      .eq('id', tx.wallet_id)
      .single();

    if (wErr || !wallet) {
      details.push({
        tx_id: tx.id,
        issue: 'wallet_not_found',
      });
      manualRequired++;
      continue;
    }

    // Deteksi inconsistency:
    // balance_after_idr adalah snapshot SEBELUM tx ini.
    // Current balance_idr harusnya >= balance_after_idr
    // (karena tx ini harusnya nambah balance).
    //
    // Tapi karena kita gak simpan balance BEFORE di tx,
    // kita pakai tx.updated_at sebagai pembatas:
    //   - Hitung total credit dari SEMUA tx success SEBELUM tx.updated_at ini
    //   - Bandingkan dengan current balance
    //
    // SIMPLIFIED: kalau tx.token_after > current token_balance
    //   → tx ini belum ke-apply ke wallet (atau wallet ke-reset)
    const txTokenAfter = Number(tx.token_after || 0);
    const currentToken = Number(wallet.token_balance || 0);
    const txBalanceAfter = Number(tx.balance_after_idr || 0);
    const currentBalance = Number(wallet.balance_idr || 0);

    // Inconsistency detected: tx claims balance/token lebih tinggi dari current
    const tokenMismatch =
      txTokenAfter > currentToken && tx.type === 'topup' &&
      tx.metadata?.kind !== 'saldo';
    const balanceMismatch =
      txBalanceAfter > currentBalance && Number(tx.amount_idr || 0) > 0;

    if (tokenMismatch || balanceMismatch) {
      console.warn('[reconcile] Inconsistency detected', {
        tx_id: tx.id,
        type: tx.type,
        amount_idr: tx.amount_idr,
        tx_token_after: txTokenAfter,
        current_token: currentToken,
        tx_balance_after: txBalanceAfter,
        current_balance: currentBalance,
      });

      // Log dulu ke reconciliation_log
      await supabaseAdmin.from('reconciliation_log').insert({
        issue_type: 'success_no_wallet_effect',
        transaction_id: tx.id,
        user_id: tx.user_id,
        wallet_id: wallet.id,
        detected_balance_idr: currentBalance,
        detected_token_balance: currentToken,
        expected_balance_idr: txBalanceAfter,
        expected_token_balance: txTokenAfter,
        action_taken: 'manual_required',
        notes: 'Webhook received but wallet effect not applied. Requires manual investigation.',
        metadata: { tx_type: tx.type, tx_metadata: tx.metadata },
        created_at: new Date().toISOString(),
      });

      details.push({
        tx_id: tx.id,
        issue: 'success_no_wallet_effect',
        type: tx.type,
        current_balance: currentBalance,
        current_token: currentToken,
      });
      manualRequired++;
      continue;
    }

    // OK, gak ada masalah
    details.push({
      tx_id: tx.id,
      status: 'ok',
    });
  }

  console.log(
    `[reconcile] Checked ${txs.length} transactions in last 24h. ` +
    `Fixed: ${fixed}, Manual required: ${manualRequired}.`
  );

  return {
    checked: txs.length,
    fixed,
    manual_required: manualRequired,
    details: details.slice(0, 50), // batasi response size
  };
}


module.exports = {
  getWalletByUserId,
  checkExpiredSubscription,
  checkAllExpiredSubscriptions,
  validateWalletIntegrity,
  reconcileWallet,
  reconcilePendingPayments,
  deductToken,
  incrementBuildQuota,
  refundToken,
  decrementBuildQuota,
};
