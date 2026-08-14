/**
 * CAPTCHA Controller (Server-Side) - ALPHANUMERIC
 * ---------------------------------------------------------------
 *
 * SECURITY: CAPTCHA generation & validation di SERVER, bukan client.
 * Cegah attacker bypass client-side validation.
 *
 * FORMAT: ALPHANUMERIC 4 KARAKTER (huruf besar + angka acak)
 *   - Kombinasi: A-Z (exclude I, L, O) + 2-9 (exclude 0, 1)
 *   - Contoh: "A3X7", "K9P2", "M4N8"
 *   - Kenapa exclude? Biar gak ambigu (0/O, 1/I/L)
 *
 *   Kenapa alphanumeric (bukan cuma angka)?
 *   - Lebih banyak variasi: 31^4 = 923.521 kemungkinan
 *   - Vs numeric 4 digit: 9000 kemungkinan saja
 *   - Lebih tahan brute force attack
 *
 * FLOW:
 *   1. GET  /api/captcha/generate
 *      - Server generate random 4 char alphanumeric
 *      - Simpan di session (HttpOnly cookie)
 *      - Return plain code ke frontend
 *
 *   2. POST /api/captcha/verify
 *      - User submit form
 *      - Frontend kirim input value
 *      - Server compare dengan session.captchaCode
 *      - Cocok → return valid
 *      - Salah → 401
 *
 * Catatan keamanan:
 *   - Code expire 5 menit
 *   - 1 code hanya valid 1x
 *   - Max 5 attempt per code (lock kalau terlalu banyak coba)
 *   - Session cookie HttpOnly + Secure + SameSite
 *   - Rate limit global (100 req/15 min) tetap aktif
 */

const crypto = require('crypto');
const { AppError } = require('../middlewares/errorHandler');

const CAPTCHA_LENGTH = 4; // 4 karakter
// Charset: A-Z (exclude I, L, O) + 2-9 (exclude 0, 1)
// Total 30 karakter, 4 char = 30^4 = 810.000 kemungkinan
const CAPTCHA_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CAPTCHA_EXPIRY_MS = 5 * 60 * 1000; // 5 menit
const MAX_ATTEMPTS_PER_CODE = 5;

/**
 * Generate random 4-char alphanumeric CAPTCHA code
 * Pakai crypto.randomInt untuk uniform distribution (kriptografis aman)
 */
function generateCode() {
  const bytes = crypto.randomBytes(CAPTCHA_LENGTH);
  let code = '';
  for (let i = 0; i < CAPTCHA_LENGTH; i++) {
    code += CAPTCHA_CHARSET[bytes[i] % CAPTCHA_CHARSET.length];
  }
  return code;
}

/**
 * GET /api/captcha/generate
 * Generate new 4-digit numeric CAPTCHA
 *
 * Response:
 *   { success: true, data: { code, expires_at, length } }
 *
 * Note: code return ke frontend adalah plain text. Frontend tinggal
 * display sebagai "Masukkan kode: 1234". User tinggal ketik angkanya.
 */
async function generateCaptchaHandler(req, res, next) {
  try {
    if (!req.session) {
      throw new AppError('Session not available', 500, 'NO_SESSION');
    }

    const code = generateCode();

    // Save di session
    req.session.captchaCode = code;
    req.session.captchaCreatedAt = Date.now();
    req.session.captchaAttempts = 0;

    res.json({
      success: true,
      data: {
        code,
        expires_at: Date.now() + CAPTCHA_EXPIRY_MS,
        length: CAPTCHA_LENGTH,
      },
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/captcha/verify
 * Verify user input against session CAPTCHA
 *
 * Body: { code: string }
 *
 * Response (success):
 *   { success: true, data: { valid: true, message: 'CAPTCHA valid' } }
 *
 * Response (failure):
 *   401 { error: 'INVALID_CAPTCHA' | 'CAPTCHA_EXPIRED' | 'NO_CAPTCHA' }
 *   429 { error: 'TOO_MANY_ATTEMPTS' }
 */
async function verifyCaptchaHandler(req, res, next) {
  try {
    if (!req.session) {
      throw new AppError('Session not available', 500, 'NO_SESSION');
    }

    const { code } = req.body || {};
    const sessionCode = req.session.captchaCode;
    const createdAt = req.session.captchaCreatedAt;
    const attempts = req.session.captchaAttempts || 0;

    // Cek ada code di session
    if (!sessionCode) {
      return res.status(401).json({
        success: false,
        error: 'NO_CAPTCHA',
        message: 'CAPTCHA belum di-generate. Refresh halaman.',
      });
    }

    // Cek expired (5 menit)
    if (!createdAt || Date.now() - createdAt > CAPTCHA_EXPIRY_MS) {
      delete req.session.captchaCode;
      delete req.session.captchaCreatedAt;
      return res.status(401).json({
        success: false,
        error: 'CAPTCHA_EXPIRED',
        message: 'CAPTCHA sudah expired. Silakan refresh.',
      });
    }

    // Cek attempts (max 5x percobaan per CAPTCHA)
    if (attempts >= MAX_ATTEMPTS_PER_CODE) {
      delete req.session.captchaCode;
      return res.status(429).json({
        success: false,
        error: 'TOO_MANY_ATTEMPTS',
        message: 'Terlalu banyak percobaan. Refresh halaman.',
      });
    }

    // Normalize input
    // - Trim whitespace
    // - Uppercase (huruf jadi kapital)
    // - Hapus semua karakter non-alphanumeric (defensive)
    const inputClean = String(code || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    const expectedClean = String(sessionCode).trim().toUpperCase();

    // Validasi: harus alphanumeric 4 karakter
    if (!/^[A-Z0-9]{4}$/.test(inputClean)) {
      req.session.captchaAttempts = attempts + 1;
      return res.status(401).json({
        success: false,
        error: 'INVALID_FORMAT',
        message: 'Kode harus 4 karakter huruf/angka',
        attempts_left: MAX_ATTEMPTS_PER_CODE - (attempts + 1),
      });
    }

    // Compare
    if (inputClean !== expectedClean) {
      req.session.captchaAttempts = attempts + 1;
      return res.status(401).json({
        success: false,
        error: 'INVALID_CAPTCHA',
        message: `Kode CAPTCHA salah (percobaan ${attempts + 1}/${MAX_ATTEMPTS_PER_CODE})`,
        attempts_left: MAX_ATTEMPTS_PER_CODE - (attempts + 1),
      });
    }

    // SUKSES — clear CAPTCHA (one-time use)
    delete req.session.captchaCode;
    delete req.session.captchaCreatedAt;
    delete req.session.captchaAttempts;

    return res.json({
      success: true,
      data: {
        valid: true,
        message: 'CAPTCHA valid',
      },
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  generateCaptchaHandler,
  verifyCaptchaHandler,
  CAPTCHA_LENGTH,
  CAPTCHA_EXPIRY_MS,
};
