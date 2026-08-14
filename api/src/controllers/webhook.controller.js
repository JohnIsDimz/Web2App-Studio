/**
 * Pakasir Webhook Controller
 * ---------------------------------------------------------------
 * Endpoint publik (TANPA requireAuth) yang dipanggil server Pakasir
 * saat status pembayaran berubah.
 *
 * SECURITY (patch 2026-08-13):
 *   1. Signature verification (HMAC-SHA256)
 *   2. Validasi nominal cocok (amount di webhook == amount di DB)
 *   3. Validasi payment_id cocok (kalau ada)
 *   4. Idempotency kuat (pakai row lock + status check + audit log)
 *   5. Reject kalau order_id bukan UUID format
 *   6. Reject kalau status DB bukan 'pending' (idempotency layer 2)
 *
 * Flow:
 *   1. Verifikasi signature → reject 401 kalau invalid
 *   2. Parse payload, validasi field wajib
 *   3. Cari transaction by order_id
 *   4. Validasi nominal + payment_id match → reject 422 kalau beda
 *   5. Validasi status DB pending → reject 409 kalau bukan pending
 *   6. Mark completed (idempotent) + apply to wallet
 *   7. Log audit trail ke table `webhook_audit`
 *
 * Kalau di tengah jalan ada error, BALIKKAN status agar bisa
 * di-retry (return 500 supaya Pakasir retry).
 */

const crypto = require('crypto');
const { verifyWebhookSignature } = require('../config/pakasir');
const {
  getTransactionByOrderId,
  markTransactionCompleted,
  applyTransactionToWallet,
  revertTransaction,
} = require('../services/transaction.service');
const { AppError } = require('../middlewares/errorHandler');
const { supabaseAdmin } = require('../config/supabase');

/**
 * POST /api/webhook/pakasir
 * Headers: x-pakasir-signature (HMAC-SHA256 hex)
 * Body:
 *   {
 *     "order_id": "uuid-xxx",
 *     "amount": 50000,
 *     "status": "completed" | "expired" | "cancelled" | "failed",
 *     "payment_id": "pakasir-pay-xxx",
 *     "completed_at": "2026-08-13T..."
 *   }
 */
async function pakasirWebhookHandler(req, res, next) {
  const requestStartedAt = Date.now();
  let auditLog = {
    ip: req.ip,
    user_agent: req.headers['user-agent'] || null,
    payload_summary: null,
    decision: null,
    reason: null,
    transaction_id: null,
    duration_ms: null,
  };

  try {
    // ============== 1. Ambil raw body & signature ==============
    // req.body = Buffer (dari express.raw() di route)
    // Convert ke string untuk HMAC verification (harus PERSIS sama dengan
    // body yang dikirim Pakasir, jangan JSON.stringify ulang!)
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
    const signature = req.headers['x-pakasir-signature'];

    // ============== 2. Verifikasi signature ==============
    const signatureValid = verifyWebhookSignature(rawBody, signature);
    if (!signatureValid) {
      auditLog.decision = 'rejected';
      auditLog.reason = 'invalid_signature';
      await writeAuditLog(auditLog);
      console.warn('[webhook] Invalid signature', {
        hasSignature: !!signature,
        rawBodyLen: rawBody.length,
        ip: req.ip,
      });
      return res.status(401).json({
        success: false,
        error: 'INVALID_SIGNATURE',
      });
    }

    // Parse payload dari raw body
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch (e) {
      auditLog.decision = 'rejected';
      auditLog.reason = 'invalid_json';
      await writeAuditLog(auditLog);
      return res.status(400).json({
        success: false,
        error: 'INVALID_JSON',
      });
    }

    const { order_id, status, amount, payment_id, completed_at } = payload;

    // ============== 3. Validasi field wajib ==============
    if (!order_id) {
      auditLog.decision = 'rejected';
      auditLog.reason = 'missing_order_id';
      await writeAuditLog(auditLog);
      return res.status(400).json({
        success: false,
        error: 'MISSING_ORDER_ID',
      });
    }

    // Validasi order_id format UUID (anti-injection / typo)
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(order_id)) {
      auditLog.decision = 'rejected';
      auditLog.reason = 'invalid_order_id_format';
      await writeAuditLog(auditLog);
      return res.status(400).json({
        success: false,
        error: 'INVALID_ORDER_ID_FORMAT',
      });
    }

    auditLog.payload_summary = {
      order_id,
      status,
      amount,
      has_payment_id: !!payment_id,
    };

    // ============== 4. Cari transaction di DB ==============
    const transaction = await getTransactionByOrderId(order_id);
    if (!transaction) {
      auditLog.decision = 'ignored';
      auditLog.reason = 'transaction_not_found';
      await writeAuditLog(auditLog);
      console.warn('[webhook] Transaction not found', { order_id });
      // Return 200 supaya Pakasir tidak retry terus-menerus
      // (kalau return 4xx/5xx, Pakasir akan terus kirim)
      return res.status(200).json({
        success: false,
        message: 'Transaction not found (ignored)',
      });
    }

    auditLog.transaction_id = transaction.id;
    auditLog.user_id = transaction.user_id;

    // ============== 5. SECURITY: Validasi nominal cocok ==============
    // Pakasir HARUS kirim amount yang SAMA dengan yang kita minta
    // saat create. Kalau beda → reject 422 (Unprocessable Entity)
    //
    // Kenapa penting? Karena kalau Pakasir bug / hacked / network glitch
    // kirim amount=50000 padahal user cuma deposit 10000, kita bisa
    // ngasih saldo 50rb ke user — itu RUGI BESAR buat kita.
    const webhookAmount = Number(amount);
    const dbAmount = Number(transaction.amount_idr);
    if (
      !Number.isFinite(webhookAmount) ||
      webhookAmount <= 0 ||
      webhookAmount !== dbAmount
    ) {
      auditLog.decision = 'rejected';
      auditLog.reason = 'amount_mismatch';
      auditLog.payload_summary = {
        ...auditLog.payload_summary,
        db_amount: dbAmount,
        webhook_amount: webhookAmount,
      };
      await writeAuditLog(auditLog);
      console.error('[webhook] AMOUNT MISMATCH! Potential fraud', {
        order_id,
        db_amount: dbAmount,
        webhook_amount: webhookAmount,
        tx_id: transaction.id,
        user_id: transaction.user_id,
      });
      // JANGAN mark complete. Return 422 supaya Pakasir cek lagi.
      // Tapi kalau Pakasir gak retry, kita perlu human follow-up.
      return res.status(422).json({
        success: false,
        error: 'AMOUNT_MISMATCH',
        message: 'Payment amount does not match transaction amount',
        expected: dbAmount,
        received: webhookAmount,
      });
    }

    // ============== 6. SECURITY: Validasi payment_id cocok ==============
    // Saat kita create transaction di Pakasir, kita simpan
    // pakasir_payment_id di metadata. Webhook harus kirim payment_id
    // yang SAMA. Kalau beda → kemungkinan webhook dari order lain
    // atau replay attack.
    if (payment_id) {
      const dbPaymentId =
        transaction.metadata?.pakasir_payment_id || null;
      if (dbPaymentId && dbPaymentId !== payment_id) {
        auditLog.decision = 'rejected';
        auditLog.reason = 'payment_id_mismatch';
        auditLog.payload_summary = {
          ...auditLog.payload_summary,
          db_payment_id: dbPaymentId,
          webhook_payment_id: payment_id,
        };
        await writeAuditLog(auditLog);
        console.error('[webhook] PAYMENT ID MISMATCH!', {
          order_id,
          db_payment_id: dbPaymentId,
          webhook_payment_id: payment_id,
        });
        return res.status(422).json({
          success: false,
          error: 'PAYMENT_ID_MISMATCH',
        });
      }
    }

    // ============== 7. Handle berdasarkan status ==============
    if (status === 'completed' || status === 'paid' || status === 'success') {
      // ============== 8. Idempotency layer 2: cek status DB ==============
      // Kalau transaction sudah bukan 'pending', webhook ini duplikat.
      // Jangan proses lagi.
      if (transaction.status !== 'pending') {
        auditLog.decision = 'ignored';
        auditLog.reason = `already_${transaction.status}`;
        await writeAuditLog(auditLog);
        return res.json({
          success: true,
          message: `Transaction already in status: ${transaction.status}`,
          transaction_id: transaction.id,
        });
      }

      // ============== 9. Anti race-condition: pakai optimistic lock ==============
      // Pakai update dengan filter status=pending, kalau return 0 row
      // berarti ada webhook lain yang sudah menang race.
      try {
        // 9a. Mark success (atomic, idempotent)
        const marked = await markTransactionCompleted(transaction.id);
        if (!marked) {
          // Race condition: webhook lain sudah duluan
          auditLog.decision = 'ignored';
          auditLog.reason = 'race_condition_lost';
          await writeAuditLog(auditLog);
          return res.json({
            success: true,
            message: 'Transaction processed by another webhook',
            transaction_id: transaction.id,
          });
        }

        // 9b. Apply effect ke wallet
        const result = await applyTransactionToWallet({
          ...transaction,
          status: 'success',
        });

        // 9c. Update metadata dengan info webhook
        await supabaseAdmin
          .from('transactions')
          .update({
            metadata: {
              ...transaction.metadata,
              webhook_received_at: new Date().toISOString(),
              webhook_payment_id: payment_id || null,
              webhook_completed_at: completed_at || null,
            },
          })
          .eq('id', transaction.id);

        auditLog.decision = 'applied';
        auditLog.duration_ms = Date.now() - requestStartedAt;
        await writeAuditLog(auditLog);

        console.log('[webhook] ✓ Transaction applied', {
          order_id,
          txId: transaction.id,
          type: transaction.type,
          duration: auditLog.duration_ms + 'ms',
          ...result,
        });

        return res.json({
          success: true,
          message: 'Transaction completed and wallet updated',
          transaction_id: transaction.id,
          wallet: result,
        });
      } catch (err) {
        // Jika apply wallet gagal, REVERT status agar bisa di-retry
        await revertTransaction(transaction.id);
        auditLog.decision = 'error';
        auditLog.reason = 'apply_wallet_failed: ' + err.message;
        auditLog.duration_ms = Date.now() - requestStartedAt;
        await writeAuditLog(auditLog);
        console.error('[webhook] Failed to apply wallet effect', err);
        // Return 500 agar Pakasir retry nanti
        throw err;
      }
    }

    if (status === 'expired' || status === 'cancelled' || status === 'failed') {
      // Tandai failed/expired, JANGAN ubah wallet
      const { error } = await supabaseAdmin
        .from('transactions')
        .update({
          status: status === 'expired' ? 'expired' : 'failed',
          metadata: {
            ...transaction.metadata,
            webhook_received_at: new Date().toISOString(),
            webhook_status: status,
          },
        })
        .eq('id', transaction.id)
        .eq('status', 'pending'); // idempotent

      if (error) {
        console.error('[webhook] Failed to mark transaction as expired/failed', error);
      }

      auditLog.decision = 'marked_' + status;
      auditLog.duration_ms = Date.now() - requestStartedAt;
      await writeAuditLog(auditLog);

      return res.json({
        success: true,
        message: `Transaction marked as ${status}`,
        transaction_id: transaction.id,
      });
    }

    // Status lain (pending) — acknowledge saja
    auditLog.decision = 'acknowledged';
    auditLog.reason = 'status_not_actionable: ' + status;
    auditLog.duration_ms = Date.now() - requestStartedAt;
    await writeAuditLog(auditLog);

    return res.json({
      success: true,
      message: 'Webhook received, no action',
      status,
    });
  } catch (err) {
    auditLog.decision = 'error';
    auditLog.reason = 'unhandled: ' + (err.message || 'unknown');
    auditLog.duration_ms = Date.now() - requestStartedAt;
    try {
      await writeAuditLog(auditLog);
    } catch (_) {
      // ignore audit log failure
    }
    return next(err);
  }
}

/**
 * Tulis audit log ke table `webhook_audit`.
 * Best-effort: kalau gagal, jangan throw (biar webhook tetep return).
 */
async function writeAuditLog(auditLog) {
  try {
    await supabaseAdmin.from('webhook_audit').insert({
      ip_address: auditLog.ip || null,
      user_agent: auditLog.user_agent || null,
      payload_summary: auditLog.payload_summary || null,
      decision: auditLog.decision || 'unknown',
      reason: auditLog.reason || null,
      transaction_id: auditLog.transaction_id || null,
      user_id: auditLog.user_id || null,
      duration_ms: auditLog.duration_ms || null,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.warn('[webhook] Failed to write audit log:', err.message);
    // Gak boleh throw — webhook harus tetep return response ke Pakasir
  }
}

module.exports = { pakasirWebhookHandler };
