/**
 * Preview Proxy Controller
 * ---------------------------------------------------------------
 * Endpoint untuk fetch website HTML dari server, bypass X-Frame-Options.
 *
 * Kenapa perlu ini?
 * - Banyak website set header "X-Frame-Options: DENY" atau
 *   "Content-Security-Policy: frame-ancestors 'none'"
 * - Browser iframe ditolak
 * - Tapi APK WebView bisa akses langsung (bukan iframe)
 *
 * Solusi: backend fetch website → rewrite response → kasih ke frontend
 * sebagai HTML yang aman untuk di-render di iframe.
 *
 * Endpoint:
 *   GET /api/preview?url=https://example.com
 *   → Returns HTML dengan X-Frame-Options dihapus + base href di-set
 */

const axios = require('axios');
const { URL } = require('url');
const { AppError } = require('../middlewares/errorHandler');

const PREVIEW_TIMEOUT = 10000;  // 10 detik
const MAX_HTML_SIZE = 5 * 1024 * 1024;  // 5 MB

// Whitelist host yang boleh di-preview (security: cegah SSRF)
const BLOCKED_HOSTS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '169.254.169.254',  // AWS metadata
  'metadata.google.internal',
];

function isBlockedUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const hostname = parsed.hostname.toLowerCase();

    // Block localhost & private IP
    if (BLOCKED_HOSTS.includes(hostname)) return true;
    if (hostname.startsWith('10.') || hostname.startsWith('192.168.')) return true;
    if (hostname.startsWith('172.') && /172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)) return true;

    // Only allow http(s)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;

    return false;
  } catch {
    return true;
  }
}

/**
 * Rewrite HTML untuk disable frame-blocking & fix relative URLs
 */
function rewriteHtml(html, baseUrl) {
  const base = new URL(baseUrl);
  const origin = base.origin;

  // Inject <base href="..."> supaya relative URL resolve correctly
  const baseTag = `<base href="${origin}/" target="_self">`;

  // Disable X-Frame-Options via meta tag (cuma work di browser yang respect meta)
  // Tapi yang paling penting: set CSP frame-ancestors *
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="frame-ancestors *;">`;

  // Inject di <head>, atau di awal <html> kalau gak ada <head>
  let rewritten = html;

  if (/<head[^>]*>/i.test(rewritten)) {
    rewritten = rewritten.replace(/<head([^>]*)>/i, `<head$1>${baseTag}${cspMeta}`);
  } else if (/<html[^>]*>/i.test(rewritten)) {
    rewritten = rewritten.replace(/<html([^>]*)>/i, `<html$1><head>${baseTag}${cspMeta}</head>`);
  } else {
    rewritten = `${baseTag}${cspMeta}${rewritten}`;
  }

  return rewritten;
}

/**
 * GET /api/preview?url=...
 * Returns HTML untuk di-render di iframe frontend
 */
async function previewProxyHandler(req, res, next) {
  try {
    const targetUrl = req.query.url;

    if (!targetUrl) {
      throw new AppError('Parameter "url" wajib diisi', 400, 'MISSING_URL');
    }

    // Decode kalau di-encode
    let decodedUrl;
    try {
      decodedUrl = decodeURIComponent(targetUrl);
    } catch {
      decodedUrl = targetUrl;
    }

    // Validasi URL
    try {
      new URL(decodedUrl);
    } catch {
      throw new AppError('URL tidak valid', 400, 'INVALID_URL');
    }

    // Security: block internal/private URLs
    if (isBlockedUrl(decodedUrl)) {
      throw new AppError(
        'URL tidak diizinkan (internal/private network)',
        403,
        'BLOCKED_URL'
      );
    }

    // Fetch website
    let response;
    try {
      response = await axios.get(decodedUrl, {
        timeout: PREVIEW_TIMEOUT,
        maxContentLength: MAX_HTML_SIZE,
        maxRedirects: 5,
        responseType: 'text',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Linux; Android 12; Web2AppStudio/1.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
        },
        validateStatus: (status) => status >= 200 && status < 400,
      });
    } catch (err) {
      if (err.code === 'ECONNABORTED') {
        throw new AppError('Timeout: website tidak merespons', 504, 'TIMEOUT');
      }
      if (err.response) {
        throw new AppError(
          `Website return HTTP ${err.response.status}`,
          err.response.status,
          'UPSTREAM_ERROR'
        );
      }
      throw new AppError(
        `Gagal fetch: ${err.message}`,
        502,
        'FETCH_ERROR'
      );
    }

    // Cek content type
    const contentType = response.headers['content-type'] || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      throw new AppError(
        `Website bukan HTML (content-type: ${contentType})`,
        415,
        'NOT_HTML'
      );
    }

    // Rewrite HTML
    const html = rewriteHtml(response.data, decodedUrl);

    // Set headers untuk embed di iframe
    // CATATAN: Backend proxy ini BYPASS X-Frame-Options, jadi iframe bisa render
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'X-Frame-Options': 'ALLOWALL',  // Allow embed (override header website)
      'Content-Security-Policy': "frame-ancestors *",  // Modern way
      'X-Proxied-By': 'Web2App-Studio',
      'X-Original-URL': decodedUrl,
      'Cache-Control': 'public, max-age=300',  // Cache 5 menit
    });

    res.send(html);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  previewProxyHandler,
  // Export untuk testing
  isBlockedUrl,
  rewriteHtml,
};
