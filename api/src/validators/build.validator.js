/**
 * Build Validator
 * ---------------------------------------------------------------
 * Validasi payload dari user + tier-based feature gating.
 *
 * Tier Matrix:
 *   - none    : Tidak ada langganan. Bayar per token (1 token = 1 build).
 *   - basic   : 35x build/bln. Fitur native standar. TIDAK boleh GPS/Push/CustomPKG.
 *   - pro     : Unlimited build. Boleh GPS + Push. TIDAK boleh CustomPKG.
 *   - premium : Unlimited. Semua fitur termasuk custom_package_name.
 */

const Joi = require('joi');
const { AppError } = require('../middlewares/errorHandler');

// =============================================
// Tier feature matrix
// =============================================
const TIER_FEATURES = {
  none: {
    // ✅ FREE TIER: 3 token gratis saat signup (cuma-coba)
    // Habis token = harus top-up atau berlangganan
    unlimitedBuild: false,
    allowsGPS: false,
    allowsPush: false,
    allowsCustomPackage: false,
    allowsCustomAppName: true,     // BOLEH custom app name
    showWatermark: true,           // Watermark "Made with Web2App Studio"
    maxTokens: 3,                  // Maximum token yang bisa di-save (cap)
    requiresToken: true,
  },
  basic: {
    unlimitedBuild: false,
    allowsGPS: false,
    allowsPush: false,
    allowsCustomPackage: false,
    allowsCustomAppName: true,
    showWatermark: false,  // Tidak ada watermark
    maxTokens: 0,          // Tidak ada cap (bisa top-up unlimited)
    requiresToken: false,  // pakai quota subscription
  },
  pro: {
    unlimitedBuild: true,
    allowsGPS: true,
    allowsPush: true,
    allowsCustomPackage: false,
    requiresToken: false,
  },
  premium: {
    unlimitedBuild: true,
    allowsGPS: true,
    allowsPush: true,
    allowsCustomPackage: true,
    requiresToken: false,
  },
};

// =============================================
// Joi schema
// =============================================
const buildPayloadSchema = Joi.object({
  project_name: Joi.string().min(2).max(60).required(),
  app_name: Joi.string().min(1).max(30).required(),
  website_url: Joi.string().uri({ scheme: ['http', 'https'] }).required(),
  package_name: Joi.string()
    .pattern(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)
    .min(5)
    .max(60)
    .optional()
    .messages({
      'string.pattern.base':
        'package_name harus lowercase dan format valid. ' +
        'Contoh: com.contoh.app atau com.web2appstudio.app (cuma huruf/angka/underscore, dipisah titik)',
    }),
  app_icon_url: Joi.string().uri().optional(),
  splash_screen_url: Joi.string().uri().optional(),
  primary_color: Joi.string().pattern(/^#[0-9A-Fa-f]{6}$/).default('#3B82F6'),
  enable_gps: Joi.boolean().default(false),
  enable_push: Joi.boolean().default(false),
  enable_offline: Joi.boolean().default(false),
  // Untuk app_config existing (opsional)
  app_config_id: Joi.string().uuid().optional(),
}).unknown(false);

/**
 * Validasi payload. Throw AppError jika invalid.
 */
function validateBuildPayload(payload) {
  const { error, value } = buildPayloadSchema.validate(payload, {
    abortEarly: false,
    stripUnknown: true,
  });
  if (error) {
    const details = error.details.map((d) => d.message).join('; ');
    throw new AppError(`Invalid payload: ${details}`, 400, 'VALIDATION_ERROR');
  }
  return value;
}

/**
 * Validasi hak user terhadap feature yang direquest
 * berdasarkan tier langganan.
 */
function validateTierFeatures(wallet, payload) {
  const tier = wallet.subscription_tier || 'none';
  const features = TIER_FEATURES[tier];

  if (!features) {
    throw new AppError(`Unknown tier: ${tier}`, 500, 'INVALID_TIER_CONFIG');
  }

  // ============================================
  // [1] CUSTOM PACKAGE NAME
  // ============================================
  // Free & Basic & Pro TIDAK BOLEH custom package name
  // HANYA Premium yang boleh.
  //
  // Contoh (Premium bebas pilih apa saja yang valid):
  //   ✓ Premium:    com.perusahaan.app
  //   ✗ Pro:        com.perusahaan.app     (DITOLAK, meski bayar 30K)
  //   ✗ Basic:      com.perusahaan.app     (DITOLAK, meski bayar 15K)
  //   ✗ Free:       com.perusahaan.app     (DITOLAK, cuma-coba)
  //   ✗ Free:       com.web2appstudio.app  (DITOLAK, meski format valid)
  //
  // Free/Basic/Pro tetap pakai package default: com.web2appstudio.<slug>
  // Premium boleh custom prefix sendiri (mis. com.perusahaan.app)
  // ============================================
  if (payload.package_name && !features.allowsCustomPackage) {
    throw new AppError(
      `Custom package name HANYA untuk tier Premium (Rp 60.000/bln). ` +
        `Tier Anda saat ini: "${tier}". ` +
        `Untuk tier lain, package name akan otomatis di-generate dari app name Anda ` +
        `(format: com.web2appstudio.<nama-app>).`,
      403,
      'FEATURE_NOT_ALLOWED',
      {
        feature: 'custom_package_name',
        current_tier: tier,
        required_tier: 'premium',
        upgrade_url: '/pricing.html#premium',
      }
    );
  }

  // Extra safety: kalau tier BUKAN premium tapi somehow package_name
  // isinya bukan pattern com.web2appstudio.*, reject.
  if (payload.package_name && tier !== 'premium') {
    if (!payload.package_name.startsWith('com.web2appstudio.')) {
      throw new AppError(
        `Custom package name harus menggunakan prefix "com.web2appstudio." ` +
          `untuk tier ${tier}. Format: com.web2appstudio.<nama-app>. ` +
          `Untuk custom prefix sendiri (misal com.perusahaan.app), upgrade ke Premium.`,
        403,
        'INVALID_PACKAGE_PREFIX'
      );
    }
  }

  // ============================================
  // [2] GPS -> Pro & Premium
  // ============================================
  if (payload.enable_gps && !features.allowsGPS) {
    throw new AppError(
      `Fitur GPS hanya untuk tier Pro/Premium. Current tier: ${tier}`,
      403,
      'FEATURE_NOT_ALLOWED',
      { feature: 'gps', current_tier: tier, required_tier: 'pro' }
    );
  }

  // [3] Push -> Pro & Premium
  if (payload.enable_push && !features.allowsPush) {
    throw new AppError(
      `Push Notification hanya untuk tier Pro/Premium. Current tier: ${tier}`,
      403,
      'FEATURE_NOT_ALLOWED',
      { feature: 'push_notification', current_tier: tier, required_tier: 'pro' }
    );
  }

  return features;
}

/**
 * Validasi hak build (quota / token).
 * Throw error jika user tidak punya hak build.
 */
function validateBuildQuota(wallet) {
  const tier = wallet.subscription_tier || 'none';
  const features = TIER_FEATURES[tier];

  // User tanpa langganan: harus pakai token
  if (features.requiresToken) {
    if ((wallet.token_balance || 0) < 1) {
      throw new AppError(
        'Token tidak cukup. Silakan top-up atau berlangganan.',
        402,
        'INSUFFICIENT_TOKEN',
        {
          token_balance: wallet.token_balance,
          required: 1,
        }
      );
    }
    return { source: 'token', cost: 1 };
  }

  // User dengan langganan: cek quota
  if (features.unlimitedBuild) {
    return { source: 'subscription_unlimited', cost: 0 };
  }

  // Basic: cek quota
  const used = wallet.build_quota_used || 0;
  const limit = wallet.build_quota_limit || 0;
  if (used >= limit) {
    throw new AppError(
      `Quota build bulan ini sudah habis (${used}/${limit}). Silakan upgrade ke Pro/Premium untuk unlimited.`,
      402,
      'QUOTA_EXHAUSTED',
      { used, limit, tier }
    );
  }
  return { source: 'subscription_quota', cost: 0 };
}

module.exports = {
  TIER_FEATURES,
  validateBuildPayload,
  validateTierFeatures,
  validateBuildQuota,
};
