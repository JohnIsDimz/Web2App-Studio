/**
 * Build Worker (Consumer)
 * ---------------------------------------------------------------
 * Process job dari Bull queue 'build-apk':
 *   1. Update build_jobs.status = 'processing'
 *   2. Jalankan runBuild() (Capacitor/Cordova CLI simulasi)
 *   3. Update build_jobs.status = 'success'/'failed' + apk_url
 *   4. Refund saldo kalau build gagal
 *
 * Jalankan sebagai proses terpisah:
 *   npm run dev:worker   (development)
 *   npm run start:worker (production)
 *
 * Untuk production, jalankan beberapa instance (pm2 / systemd)
 * dengan concurrency = BUILD_MAX_CONCURRENT.
 */

require('dotenv').config();

const { getBuildQueue, BUILD_MAX_CONCURRENT } = require('../config/queue');
const { supabaseAdmin } = require('../config/supabase');
const { runBuild } = require('../services/builder.service');
const walletService = require('../services/wallet.service');
const { APP_DOWNLOAD_BASE_URL } = require('../controllers/build.controller');

const LINK_EXPIRY_DAYS = 7;

async function processBuildJob(bullJob) {
  const { jobId, userId, userFullName, config, appConfigId } = bullJob.data;
  const startedAt = new Date();

  console.log(`[worker] Starting build job ${jobId} for user ${userId}`);

  try {
    // [1] Mark processing
    await supabaseAdmin
      .from('build_jobs')
      .update({
        status: 'processing',
        started_at: startedAt.toISOString(),
        bull_job_id: String(bullJob.id),
      })
      .eq('id', jobId);

    // [2] Run build (simulasi CLI)
    const result = await runBuild({
      jobId,
      config,
      onLog: (line) => {
        // Optionally pipe log ke Bull job log
        // bullJob.log(line); // disabled by default (memory)
        process.stdout.write(`[${jobId.slice(0, 8)}] ${line}`);
      },
    });

    const finishedAt = new Date();
    const expiresAt = new Date(
      finishedAt.getTime() + LINK_EXPIRY_DAYS * 24 * 60 * 60 * 1000
    );
    const apkUrl = `${APP_DOWNLOAD_BASE_URL}/${jobId}/${slugify(
      config.app_name
    )}.apk`;

    // [3] Mark success
    await supabaseAdmin
      .from('build_jobs')
      .update({
        status: 'success',
        finished_at: finishedAt.toISOString(),
        build_duration_ms: result.durationMs,
        apk_url: apkUrl,
        apk_size_bytes: result.apkSize,
        expires_at: expiresAt.toISOString(),
      })
      .eq('id', jobId);

    // [4] Update transaction 'build' jadi success
    await supabaseAdmin
      .from('transactions')
      .update({
        status: 'success',
        balance_after_idr: undefined,
      })
      .eq('reference_id', jobId)
      .eq('type', 'build');

    console.log(
      `[worker] ✓ Build job ${jobId} completed in ${result.durationMs}ms` +
        ` → ${apkUrl}`
    );

    return {
      jobId,
      status: 'success',
      apkUrl,
      durationMs: result.durationMs,
    };
  } catch (err) {
    console.error(`[worker] ✗ Build job ${jobId} failed:`, err.message);

    const finishedAt = new Date();

    // Mark failed
    await supabaseAdmin
      .from('build_jobs')
      .update({
        status: 'failed',
        finished_at: finishedAt.toISOString(),
        error_message: err.message,
      })
      .eq('id', jobId);

    // Update transaction 'build' jadi failed
    await supabaseAdmin
      .from('transactions')
      .update({ status: 'failed' })
      .eq('reference_id', jobId)
      .eq('type', 'build');

    // REFUND: kembalikan saldo / quota karena build gagal
    try {
      const { data: job } = await supabaseAdmin
        .from('build_jobs')
        .select('token_cost, user_id')
        .eq('id', jobId)
        .single();

      if (job) {
        if (job.token_cost > 0) {
          // Legacy: refund token
          await walletService.refundToken(job.user_id, job.token_cost);
          console.log(
            `[worker] Refunded ${job.token_cost} token to user ${job.user_id}`
          );
        } else {
          // Sistem baru: refund saldo
          await walletService.refundSaldoForBuild(
            job.user_id,
            jobId
          );
          console.log(
            `[worker] Refunded Rp 500 saldo to user ${job.user_id}`
          );
        }
      }
    } catch (refundErr) {
      console.error(`[worker] Refund failed for job ${jobId}:`, refundErr);
    }

    throw err;
  }
}

function slugify(str) {
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'app';
}

// =============================================
// Bootstrap worker
// =============================================
async function start() {
  console.log('========================================');
  console.log('🔨 Web2App Studio - Build Worker');
  console.log(`   Concurrency: ${BUILD_MAX_CONCURRENT}`);
  console.log('========================================');

  const queue = getBuildQueue();
  queue.process('build-apk', BUILD_MAX_CONCURRENT, processBuildJob);

  queue.on('completed', (job, result) => {
    console.log(`[worker] Job ${job.id} completed:`, result);
  });

  queue.on('failed', (job, err) => {
    console.error(`[worker] Job ${job?.id} failed:`, err.message);
  });

  queue.on('error', (err) => {
    console.error('[worker] Queue error:', err.message);
  });

  console.log('[worker] Waiting for build jobs...');
}

if (require.main === module) {
  start().catch((err) => {
    console.error('[worker] Fatal startup error:', err);
    process.exit(1);
  });

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\n[worker] ${signal} received, closing...`);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { processBuildJob, start };
