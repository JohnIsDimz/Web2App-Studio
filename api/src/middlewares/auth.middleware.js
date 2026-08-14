/**
 * Auth Middleware
 * ---------------------------------------------------------------
 * Memvalidasi JWT Supabase Auth dari header request.
 *
 * Frontend HARUS mengirim:
 *   Authorization: Bearer <supabase_access_token>
 *
 * Token diverifikasi via Supabase `auth.getUser(token)`.
 * Jika valid, req.user akan berisi { id, email, ... }.
 * Jika tidak, request ditolak 401.
 */

const { supabaseAdmin } = require('../config/supabase');

/**
 * Wajib login. Attach req.user jika sukses.
 */
const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const [scheme, token] = authHeader.split(' ');

    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({
        success: false,
        error: 'UNAUTHORIZED',
        message: 'Missing or malformed Authorization header',
      });
    }

    // Verifikasi token ke Supabase Auth
    const { data, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !data?.user) {
      return res.status(401).json({
        success: false,
        error: 'INVALID_TOKEN',
        message: 'Invalid or expired access token',
      });
    }

    // Attach user ke request
    req.user = {
      id: data.user.id,
      email: data.user.email,
      phone: data.user.phone,
      role: data.user.role || 'authenticated',
      appMetadata: data.user.app_metadata,
      userMetadata: data.user.user_metadata,
    };
    req.accessToken = token;

    return next();
  } catch (err) {
    return next(err);
  }
};

/**
 * Opsional: jika ada token, set req.user; jika tidak, tetap lanjut.
 * Berguna untuk endpoint publik yang punya perilaku beda
 * untuk user login (mis. /pricing, /public-stats).
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const [scheme, token] = authHeader.split(' ');
    if (scheme !== 'Bearer' || !token) return next();

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (!error && data?.user) {
      req.user = {
        id: data.user.id,
        email: data.user.email,
        role: data.user.role || 'authenticated',
      };
      req.accessToken = token;
    }
    return next();
  } catch (err) {
    return next(err);
  }
};

/**
 * Role-based guard (opsional, untuk admin endpoint di kemudian hari).
 */
const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'UNAUTHORIZED',
        message: 'Authentication required',
      });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: 'FORBIDDEN',
        message: `Role '${req.user.role}' not allowed`,
      });
    }
    return next();
  };
};

module.exports = { requireAuth, optionalAuth, requireRole };
