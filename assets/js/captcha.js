/**
 * Web2App Studio - CAPTCHA Helper (Server-Side, NUMERIC)
 * ============================================
 *
 * SECURITY: CAPTCHA di-generate & divalidasi di SERVER.
 * Client cuma display & input. Tampering dicegah.
 *
 * FORMAT: 4 DIGIT ANGKA (numeric only)
 *   - User-friendly: tinggal ketik angka
 *   - Mobile-friendly: numeric keyboard otomatis
 *   - Tidak perlu OCR / image recognition
 *
 * FLOW:
 *   1. Page load → GET /api/captcha/generate
 *      Server: generate 4 digit code, simpan di session (HttpOnly cookie)
 *      Response: { code, expires_at, length }
 *
 *   2. Frontend display code di <div> sebagai plain text
 *      (bukan di canvas/gambar — pure numeric)
 *
 *   3. User submit form
 *      Frontend → POST /api/captcha/verify { code: input }
 *      Server: compare dengan session.captchaCode
 *      - Cocok → return { valid: true }
 *      - Salah → 401 + increment attempts
 *      - 5x salah → lock
 */

(function () {
  'use strict';

  /**
   * Generate CAPTCHA baru dari server
   *
   * @param {string} containerId - ID element untuk display code
   * @returns {Promise<{code, expiresAt}>} expiresAt = epoch ms
   */
  async function generate(containerId) {
    const container = document.getElementById(containerId);
    if (!container) {
      console.warn(`[captcha] Container #${containerId} not found`);
      return null;
    }

    try {
      const res = await fetch(`${window.API_BASE_URL}/captcha/generate`, {
        method: 'GET',
        credentials: 'include',
      });

      if (!res.ok) {
        console.error('[captcha] generate failed:', res.status);
        container.textContent = 'Gagal memuat';
        return null;
      }

      const data = await res.json();
      if (!data.success) {
        container.textContent = 'Server error';
        return null;
      }

      // Display plain numeric code (4 digit)
      container.textContent = data.data.code;

      return {
        code: data.data.code,
        expiresAt: data.data.expires_at,
      };
    } catch (err) {
      console.error('[captcha] network error:', err);
      container.textContent = 'Network error';
      return null;
    }
  }

  /**
   * Verify CAPTCHA input ke server
   *
   * @param {string} input - User input (4 digit angka)
   * @returns {Promise<{success: boolean, message: string, attemptsLeft?: number}>}
   */
  async function verify(input) {
    try {
      const res = await fetch(`${window.API_BASE_URL}/captcha/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ code: input }),
      });

      const data = await res.json();

      return {
        success: res.ok && data.success === true,
        message: data.message || (res.ok ? 'Valid' : 'Invalid'),
        attemptsLeft: data.attempts_left,
        status: res.status,
      };
    } catch (err) {
      console.error('[captcha] verify error:', err);
      return {
        success: false,
        message: 'Network error',
      };
    }
  }

  // Expose
  window.Web2AppCaptcha = {
    generate,
    verify,
  };
})();
