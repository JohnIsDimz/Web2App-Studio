/**
 * Build Controller
 * ---------------------------------------------------------------
 * Endpoint:
 *   POST /api/build           - Trigger build APK (queue)
 *   GET  /api/build/:jobId    - Cek status build
 *   GET  /api/build           - History build user
 *
 * Flow POST /api/build:
 *   1. requireAuth (Tahap 2 middleware)
 *   2. Validasi payload + tier features + quota
 *   3. Save app_config (atau reuse existing by app_config_id)
 *   4. Potong token ATAU increment quota
 *   5. Insert build_jobs (status: queued)
 *   6. Enqueue ke Bull queue
 *   7. Return job_id + estimated_time
 *
 * Worker (build.worker.js) handle eksekusi + email.
 */

const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../config/supabase');
const { getBuildQueue } = require('../config/queue');
const { AppError } = require('../middlewares/errorHandler');
const {
  validateBuildPayload,
  validateTierFeatures,
  validateBuildQuota,
} = require('../validators/build.validator');
const walletService = require('../services/wallet.service');

const APP_DOWNLOAD_BASE_URL =
  process.env.APP_DOWNLOAD_BASE_URL || 'https://downloads.web2appstudio.com';

/**
 * POST /api/build
 */
async function createBuildHandler(req, res, next) {
  try {
    const userId = req.user.id;

    // ========== [0] CHECK SUBSCRIPTION EXPIRY ==========
    // Lazy check: kalau subscription expired, downgrade ke 'none'
    // sebelum lanjut validasi
    await walletService.checkExpiredSubscription(req.user.id);

    // ========== [0.5] DATA INTEGRITY CHECK ==========
    // JAMINAN: Saldo & token user TIDAK AKAN HILANG saat:
    //   - Login (read-only operation)
    //   - Refresh dashboard
    //   - Build sukses (token cuma decrement 1)
    //   - Build gagal (token di-REFUND)
    //   - Cron job (subscription expire: token TIDAK di-reset)
    //
    // Sanity check: pastikan wallet tidak invalid (negative, null, dll)
    const integrityCheck = await walletService.validateWalletIntegrity(req.user.id);
    if (!integrityCheck.valid) {
      // Log error tapi TIDAK block user (data sudah aman, hanya notifikasi)
      console.error('[INTEGRITY]', integrityCheck);
      // Optional: kirim alert ke admin
    }

    // ========== [1] Validasi payload ==========
    const payload = validateBuildPayload(req.body);

    // ========== [2] Ambil wallet & validasi hak ==========
    const wallet = await walletService.getWalletByUserId(userId);
    const tierFeatures = validateTierFeatures(wallet, payload);
    const quotaInfo = validateBuildQuota(wallet);

    // ========== [3] Save / reuse app_config ==========
    let appConfigId = payload.app_config_id;
    if (appConfigId) {
      // Validasi existing config milik user
      const { data: existing } = await supabaseAdmin
        .from('app_configs')
        .select('id')
        .eq('id', appConfigId)
        .eq('user_id', userId)
        .single();
      if (!existing) {
        throw new AppError('app_config_id not found or not owned', 404);
      }
    } else {
      // ============================================
      // Package name: hanya Premium yang boleh custom
      // Free/Basic/Pro: PAKSA default com.web2appstudio.<nama-app>
      // (validateTierFeatures di atas sudah throw error untuk
      // tier non-premium yang kirim package_name non-default,
      // tapi di sini kita double-check sebagai defense in depth)
      // ============================================
      const tier = wallet.subscription_tier || 'none';
      const finalPackageName =
        tier === 'premium' && payload.package_name
          ? payload.package_name
          : `com.web2appstudio.${slugify(payload.app_name)}`;

      const { data: newConfig, error: cfgErr } = await supabaseAdmin
        .from('app_configs')
        .insert({
          user_id: userId,
          project_name: payload.project_name,
          app_name: payload.app_name,
          package_name: finalPackageName,
          website_url: payload.website_url,
          app_icon_url: payload.app_icon_url || null,
          splash_screen_url: payload.splash_screen_url || null,
          primary_color: payload.primary_color,
          enable_gps: payload.enable_gps,
          enable_push: payload.enable_push,
          enable_offline: payload.enable_offline,
          metadata: {
            created_via: 'api/build',
            tier_at_creation: wallet.subscription_tier,
          },
        })
        .select()
        .single();
      if (cfgErr) {
        throw new AppError(
          `Failed to save app_config: ${cfgErr.message}`,
          500,
          'DB_INSERT_FAILED'
        );
      }
      appConfigId = newConfig.id;
    }

    // ========== [4] Potong token / increment quota (ATOMIC) ==========
    if (quotaInfo.source === 'token') {
      await walletService.deductToken(userId, 1);
    } else if (quotaInfo.source === 'subscription_quota') {
      await walletService.incrementBuildQuota(userId);
    }
    // 'subscription_unlimited' = no quota change

    // ========== [5] Insert build_jobs row (status: queued) ==========
    const jobId = uuidv4();
    const priority =
      wallet.is_vip_queue || wallet.subscription_tier === 'premium'
        ? 'vip'
        : 'normal';

    const { data: buildJob, error: jobErr } = await supabaseAdmin
      .from('build_jobs')
      .insert({
        id: jobId,
        user_id: userId,
        app_config_id: appConfigId,
        status: 'queued',
        priority,
        token_cost: quotaInfo.source === 'token' ? 1 : 0,
        wallet_id: wallet.id,
      })
      .select()
      .single();

    if (jobErr) {
      // ROLLBACK: kembalikan token/quota
      if (quotaInfo.source === 'token') {
        await walletService.refundToken(userId, 1);
      } else if (quotaInfo.source === 'subscription_quota') {
        await walletService.decrementBuildQuota(userId);
      }
      throw new AppError(
        `Failed to create build job: ${jobErr.message}`,
        500,
        'DB_INSERT_FAILED'
      );
    }

    // ========== [6] Catat transaksi 'build' untuk audit ==========
    await supabaseAdmin.from('transactions').insert({
      user_id: userId,
      wallet_id: wallet.id,
      type: 'build',
      status: 'pending',
      amount_idr: 0,
      token_amount: quotaInfo.source === 'token' ? -1 : 0,
      reference_id: jobId,
      description: `Build APK: ${payload.app_name}`,
      metadata: {
        job_id: jobId,
        app_config_id: appConfigId,
        quota_source: quotaInfo.source,
      },
    });

    // ========== [7] Enqueue ke Bull ==========
    const queue = getBuildQueue();
    const bullJob = await queue.add(
      'build-apk',
      {
        jobId,
        userId,
        userEmail: req.user.email,
        userFullName: req.user.userMetadata?.full_name || req.user.email,
        appConfigId,
        config: payload,
      },
      {
        priority: priority === 'vip' ? 1 : 10, // Bull: lower = higher priority
        jobId, // gunakan jobId yang sama untuk traceability
      }
    );

    // ========== [8] Response ==========
    return res.status(202).json({
      // 202 = Accepted (queued for processing)
      success: true,
      message:
        'Build job berhasil di-queue. Anda akan menerima email saat APK siap.',
      data: {
        job_id: jobId,
        bull_job_id: bullJob.id,
        status: 'queued',
        priority,
        app_name: payload.app_name,
        quota_used: quotaInfo,
        tier: wallet.subscription_tier,
        estimated_time: '1-5 menit',
        poll_url: `/api/build/${jobId}`,
      },
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/build/:jobId
 * Cek status build (untuk polling frontend).
 */
async function getBuildStatusHandler(req, res, next) {
  try {
    const { jobId } = req.params;
    const userId = req.user.id;

    const { data: job, error } = await supabaseAdmin
      .from('build_jobs')
      .select('*, app_configs(*)')
      .eq('id', jobId)
      .eq('user_id', userId)
      .single();

    if (error || !job) {
      throw new AppError('Build job not found', 404, 'NOT_FOUND');
    }

    // Bentuk response URL download
    const response = {
      job_id: job.id,
      status: job.status,
      priority: job.priority,
      app_name: job.app_configs?.app_name,
      website_url: job.app_configs?.website_url,
      created_at: job.created_at,
      started_at: job.started_at,
      finished_at: job.finished_at,
      duration_ms: job.build_duration_ms,
      error_message: job.error_message,
    };

    if (job.status === 'success' && job.apk_url) {
      response.apk_url = job.apk_url;
      response.apk_size_bytes = job.apk_size_bytes;
      response.expires_at = job.expires_at;
    }

    return res.json({ success: true, data: response });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/build
 * List build history user.
 */
async function listBuildsHandler(req, res, next) {
  try {
    const userId = req.user.id;
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;

    const { data, error, count } = await supabaseAdmin
      .from('build_jobs')
      .select(
        `
        id, status, priority, created_at, finished_at,
        build_duration_ms, apk_size_bytes, error_message,
        app_configs (app_name, website_url, package_name)
      `,
        { count: 'exact' }
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      throw new AppError(error.message, 500, 'DB_QUERY_FAILED');
    }

    return res.json({
      success: true,
      data: data || [],
      pagination: { limit, offset, total: count || 0 },
    });
  } catch (err) {
    return next(err);
  }
}

// =============================================
// Helpers
// =============================================
function slugify(str) {
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'app';
}

module.exports = {
  createBuildHandler,
  getBuildStatusHandler,
  listBuildsHandler,
  APP_DOWNLOAD_BASE_URL,
};
