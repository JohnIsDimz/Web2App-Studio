/**
 * Bull Queue Configuration
 * ---------------------------------------------------------------
 * Queue untuk build APK. Producer = build.controller, Consumer = build.worker.
 *
 * Queue 'build-apk':
 *   - Concurrency: BUILD_MAX_CONCURRENT
 *   - Priority: VIP > Normal
 *   - Retry: 1 attempt, exponential backoff
 *   - Timeout: BUILD_TIMEOUT_MS
 *
 * Memerlukan Redis berjalan di REDIS_HOST:REDIS_PORT.
 */

const Queue = require('bull');
const Redis = require('ioredis');

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT) || 6379;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
const REDIS_DB = Number(process.env.REDIS_DB) || 0;
const BUILD_MAX_CONCURRENT = Number(process.env.BUILD_MAX_CONCURRENT) || 3;
const BUILD_TIMEOUT_MS = Number(process.env.BUILD_TIMEOUT_MS) || 300000;
const VIP_QUEUE_PRIORITY = process.env.VIP_QUEUE_PRIORITY !== 'false';

const QUEUE_NAME = 'build-apk';

const redisOptions = {
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
  db: REDIS_DB,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

let queueInstance = null;

/**
 * Get singleton queue instance.
 * NOTE: Queue otomatis membuat koneksi Redis, jadi instantiate SEKALI
 * per process. Untuk worker, import dari file yang sama.
 */
function getBuildQueue() {
  if (queueInstance) return queueInstance;

  queueInstance = new Queue(QUEUE_NAME, {
    redis: redisOptions,
    defaultJobOptions: {
      attempts: 1, // build tidak di-retry otomatis
      removeOnComplete: 100, // keep last 100 completed
      removeOnFail: 200,
      timeout: BUILD_TIMEOUT_MS,
    },
  });

  queueInstance.on('error', (err) => {
    console.error('[queue] Redis error:', err.message);
  });

  return queueInstance;
}

module.exports = {
  QUEUE_NAME,
  getBuildQueue,
  redisOptions,
  BUILD_MAX_CONCURRENT,
  VIP_QUEUE_PRIORITY,
};
