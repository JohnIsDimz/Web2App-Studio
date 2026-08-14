/**
 * Web2App Studio - Backend Server
 * ---------------------------------------------------------------
 * Entry point. Bootstraps Express + Supabase + Pakasir.
 *
 * SECURITY (patch 2026-08-13):
 *   - HTTPS enforcement (production)
 *   - HSTS header
 *   - Helmet (CSP, X-Frame-Options, etc)
 *   - express-session (HttpOnly + Secure + SameSite cookies)
 *   - cookie-parser
 *   - Rate limit (global + per-endpoint)
 *   - CORS whitelist
 *   - MongoDB-style session (in-memory dev, Redis production)
 */

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const cookieParser = require('cookie-parser');

const apiRoutes = require('./routes/api.routes');
const {
  errorHandler,
  notFoundHandler,
} = require('./middlewares/errorHandler');
const { assertSupabaseConfig } = require('./config/supabase');
const { assertPakasirConfig } = require('./config/pakasir');

const app = express();
const PORT = Number(process.env.APP_PORT) || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const COOKIE_SECRET = process.env.COOKIE_SECRET || 'dev-only-cookie-secret-please-change-in-prod-min-32-chars';

// ======================
// Validasi env di startup
// ======================
try {
  assertSupabaseConfig();
  assertPakasirConfig();
  if (IS_PRODUCTION && COOKIE_SECRET === 'dev-only-cookie-secret-please-change-in-prod-min-32-chars') {
    throw new Error('COOKIE_SECRET harus di-set di production!');
  }
} catch (err) {
  console.error('❌ Configuration error:', err.message);
  console.error('   Pastikan .env sudah diisi lengkap (lihat .env.example)');
  if (IS_PRODUCTION) process.exit(1);
}

// ======================
// HTTPS ENFORCEMENT (production only)
// ======================
// Force redirect HTTP → HTTPS di production
if (IS_PRODUCTION) {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });
  console.log('✓ HTTPS enforcement: ON');
}

// ======================
// Trust proxy (untuk X-Forwarded-* headers dari Nginx)
// ======================
app.set('trust proxy', 1);

// ======================
// HELMET — Security Headers
// ======================
// CSP: ketat, allow Supabase + Google Fonts
app.use(
  helmet({
    // Content Security Policy
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Supabase (auth) + Google Fonts
        connectSrc: [
          "'self'",
          'https://*.supabase.co',
          'https://fonts.googleapis.com',
          'https://fonts.gstatic.com',
        ],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",  // Inline scripts di HTML kita
          "'unsafe-eval'",    // eval() di captcha.js (no, tapi helmet default strict)
          'https://cdn.jsdelivr.net',  // Supabase JS
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://cdn.jsdelivr.net',
          'https://fonts.googleapis.com',
        ],
        fontSrc: [
          "'self'",
          'https://fonts.gstatic.com',
          'data:',
        ],
        imgSrc: [
          "'self'",
          'data:',
          'blob:',
          'https:',  // Untuk preview iframe & icon
        ],
        frameSrc: [
          "'self'",
        ],
        // CRITICAL: Anti-clickjacking
        frameAncestors: ["'self'"],
      },
    },
    // HSTS: force HTTPS 1 tahun (production only)
    strictTransportSecurity: IS_PRODUCTION
      ? {
          maxAge: 31536000, // 1 tahun
          includeSubDomains: true,
          preload: true,
        }
      : false,
    // X-Frame-Options: DENY (anti-clickjacking)
    frameguard: { action: 'deny' },
    // X-Content-Type-Options: nosniff
    noSniff: true,
    // Referrer-Policy
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    // X-Permitted-Cross-Domain-Policies: none
    permittedCrossDomainPolicies: { permittedPolicies: 'none' },
    // X-DNS-Prefetch-Control: off
    dnsPrefetchControl: { allow: false },
    // Cross-Origin-Opener-Policy
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    // Cross-Origin-Resource-Policy
    crossOriginResourcePolicy: { policy: 'same-site' },
    // Hide X-Powered-By
    hidePoweredBy: true,
  })
);
console.log('✓ Helmet security headers: ON');

// ======================
// CORS
// ======================
const allowedOrigins = (process.env.APP_FRONTEND_URL || 'http://localhost:5500,http://localhost:3000')
  .split(',')
  .map((s) => s.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow same-origin (gak ada origin header) atau whitelisted
      if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.warn(`[cors] Blocked origin: ${origin}`);
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      }
    },
    credentials: true,  // Allow cookies cross-origin
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-cron-secret'],
    maxAge: 86400,  // Cache preflight 24 jam
  })
);
console.log(`✓ CORS: ${allowedOrigins.join(', ')}`);

// ======================
// COOKIE PARSER + SESSION
// ======================
app.use(cookieParser(COOKIE_SECRET));

// Session config (Redis store di production, in-memory di dev)
const sessionConfig = {
  name: 'wb2.sid',  // Gak pakai default 'connect.sid' (less obvious)
  secret: COOKIE_SECRET,
  resave: false,
  saveUninitialized: false,  // Gak create session sampai ada data
  rolling: true,  // Reset expiry on each request
  cookie: {
    httpOnly: true,        // JS gak bisa akses (anti-XSS)
    secure: IS_PRODUCTION, // HTTPS only di production
    sameSite: 'lax',       // CSRF protection (strict juga OK tapi bisa block legit)
    maxAge: 24 * 60 * 60 * 1000, // 24 jam
    path: '/',
  },
};

if (IS_PRODUCTION) {
  // Production: pakai Redis (sama dengan Bull Queue).
  // Benefit: session persist across PM2 restart, multi-instance safe.
  try {
    const RedisStore = require('connect-redis').default;
    const { createClient } = require('redis');
    const redisClient = createClient({
      socket: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: Number(process.env.REDIS_PORT) || 6379,
      },
      password: process.env.REDIS_PASSWORD || undefined,
      database: Number(process.env.REDIS_DB) || 0,
    });
    redisClient.on('error', (err) => console.error('[redis-session]', err.message));
    redisClient.connect().then(() => {
      console.log(`✓ Redis session store: ${process.env.REDIS_HOST || '127.0.0.1'}:${process.env.REDIS_PORT || 6379}`);
    });
    sessionConfig.store = new RedisStore({
      client: redisClient,
      prefix: 'wb2:sess:',
      ttl: 24 * 60 * 60, // 24 jam (sesuai cookie maxAge)
    });
  } catch (err) {
    console.warn('⚠ connect-redis tidak terinstall / Redis gagal connect.');
    console.warn('  Install: cd api && npm install connect-redis@^7 redis@^4');
    console.warn('  Fallback ke in-memory (session HILANG saat PM2 restart!)');
  }
}
app.use(session(sessionConfig));
console.log(`✓ Session: ON (HttpOnly cookie, ${IS_PRODUCTION ? 'Redis' : 'in-memory'} store)`);

// ======================
// RATE LIMIT (global)
// ======================
app.use(morgan(IS_PRODUCTION ? 'combined' : 'dev'));

const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'TOO_MANY_REQUESTS',
    message: 'Terlalu banyak request, coba lagi nanti',
  },
});
app.use('/api', limiter);

// ======================
// Body Parser
// ======================
// Default JSON parser untuk semua endpoint (limit 1mb anti-DoS).
// CATATAN: /api/webhook/pakasir dipasang dengan express.raw() sendiri
// di route definition (lihat api.routes.js) supaya HMAC bisa verify
// body yang PERSIS sama dengan yang dikirim Pakasir.
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ======================
// API Routes
// ======================
app.get('/', (req, res) => {
  res.json({
    name: process.env.APP_NAME || 'Web2App Studio API',
    version: '0.1.0',
    status: 'running',
    docs: '/api/health',
  });
});

app.use('/api', apiRoutes);

// ======================
// Error Handling
// ======================
app.use(notFoundHandler);
app.use(errorHandler);

// ======================
// Start Server
// ======================
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log(`🚀 ${process.env.APP_NAME || 'Web2App Studio API'}`);
  console.log(`   Env:     ${process.env.NODE_ENV || 'development'}`);
  console.log(`   URL:     http://localhost:${PORT}`);
  console.log(`   Health:  http://localhost:${PORT}/api/health`);
  console.log(`   Mode:    ${IS_PRODUCTION ? 'PRODUCTION (HTTPS enforced)' : 'development'}`);
  console.log('========================================');
});

// Graceful shutdown
const shutdown = (signal) => {
  console.log(`\n${signal} received, shutting down gracefully...`);
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
