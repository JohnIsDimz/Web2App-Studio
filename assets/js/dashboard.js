/**
 * ============================================
 * DASHBOARD BUILDER LOGIC
 * ============================================
 * Fitur:
 *  - Load user wallet & display token/tier/quota
 *  - Lock/unlock tier-based features
 *  - Handle build form submit
 *  - Poll build status
 *  - Render build history
 * ============================================
 */

(function () {
  'use strict';

  // Init Supabase
  if (window.Web2AppAuth) Web2AppAuth.initSupabase();

  // =============================================
  // TIER CONFIG
  // =============================================
  const TIER_LEVEL = { none: 0, basic: 1, pro: 2, premium: 3 };

  const TIER_META = {
    none:    { label: 'NONE',    color: 'gray-500',  badge: 'badge-nb' },
    basic:   { label: 'BASIC',   color: 'cyan-400',  badge: 'badge-nb-blue' },
    pro:     { label: 'PRO',     color: 'yellow-300', badge: 'badge-nb-yellow' },
    premium: { label: 'PREMIUM', color: 'pink-400',  badge: 'badge-nb-red' },
  };

  // =============================================
  // STATE
  // =============================================
  const state = {
    user: null,
    wallet: null,
    isBuilding: false,
  };

  // Expose state untuk welcome modal (global)
  window.dashboardState = state;

  // =============================================
  // AUTH GUARD
  // =============================================
  async function init() {
    const session = await Web2AppAuth.requireAuthGuard();
    if (!session) return;

    state.user = session.user;
    const displayName = state.user.user_metadata?.full_name || state.user.email.split('@')[0];
    document.getElementById('userName').textContent = displayName;

    await loadWallet();

    // ✓ TAMPILKAN POPUP WELCOME BACK (user lama, setiap buka dashboard)
    // Detect: user.created_at > 1 menit yang lalu = bukan signup baru
    const createdAt = new Date(state.user.created_at);
    const now = new Date();
    const isJustRegistered = (now - createdAt) < 60 * 1000; // 1 menit

    if (!isJustRegistered && window.Web2AppUI?.showWelcomeModal) {
      // Show welcome back popup
      setTimeout(() => {
        Web2AppUI.showWelcomeModal({
          name: displayName,
          email: state.user.email,
          isNewUser: false,
        });
      }, 500);
    }

    await loadBuildHistory();
    setupEventListeners();
  }

  // =============================================
  // LOAD WALLET
  // =============================================
  async function loadWallet() {
    const wallet = await Web2AppAPI.getMyWallet();
    state.wallet = wallet;

    if (!wallet) {
      Web2AppUI.showToast('Gagal memuat wallet. Coba refresh.', 'error');
      return;
    }

    const tier = wallet.subscription_tier || 'none';
    const meta = TIER_META[tier];

    // Update UI
    document.getElementById('tokenBalance').textContent = wallet.token_balance || 0;
    document.getElementById('userTier').textContent = meta.label;
    document.getElementById('userTier').className = `text-2xl font-black bg-${meta.color} px-2`;

    const limit = wallet.build_quota_limit || 0;
    const used = wallet.build_quota_used || 0;
    const quotaText = limit === 0 ? `${used}/∞` : `${used}/${limit}`;
    document.getElementById('userQuota').textContent = quotaText;

    // Tier badge di form
    const tierBadge = document.getElementById('tierBadge');
    tierBadge.textContent = `TIER: ${meta.label}`;
    tierBadge.className = `badge-nb ${meta.badge}`;

    // Apply tier-based UI
    applyTierGates(tier);

    // Show upgrade banner kalau tier rendah
    const upgradeBanner = document.getElementById('upgradeBanner');
    if (TIER_LEVEL[tier] < TIER_LEVEL.pro) {
      upgradeBanner.classList.remove('hidden');
    } else {
      upgradeBanner.classList.add('hidden');
    }

    // ✓ Show free tier banner (hanya untuk tier 'none' / free trial)
    const freeTierBanner = document.getElementById('freeTierBanner');
    const watermarkWarning = document.getElementById('watermarkWarning');
    if (tier === 'none') {
      if (freeTierBanner) freeTierBanner.classList.remove('hidden');
      if (watermarkWarning) watermarkWarning.classList.remove('hidden');
      // Update token counter
      const tokensLeft = wallet.token_balance || 0;
      const freeTokensLeftEl = document.getElementById('freeTokensLeft');
      if (freeTokensLeftEl) {
        freeTokensLeftEl.textContent = tokensLeft;
        // Ubah warna berdasarkan sisa token
        if (tokensLeft === 0) {
          freeTokensLeftEl.className = 'text-red-600';
          if (freeTierBanner) freeTierBanner.className = 'bg-red-100 border-3 border-black p-3 mb-3';
        } else if (tokensLeft <= 1) {
          freeTokensLeftEl.className = 'text-orange-600';
        } else {
          freeTokensLeftEl.className = 'text-green-600';
        }
      }
    } else {
      if (freeTierBanner) freeTierBanner.classList.add('hidden');
      if (watermarkWarning) watermarkWarning.classList.add('hidden');
    }
  }

  // =============================================
  // TIER GATING (DISABLE INPUT)
  // =============================================
  function applyTierGates(tier) {
    const level = TIER_LEVEL[tier] || 0;

    // Custom Package Name -> Premium only (level 3)
    const customPkgCheckbox = document.getElementById('customPkgCheckbox');
    const customPkgRow = document.getElementById('customPkgRow');
    const packageNameWrapper = document.getElementById('packageNameWrapper');

    if (level >= TIER_LEVEL.premium) {
      customPkgCheckbox.disabled = false;
      customPkgRow.classList.remove('feature-locked');
    } else {
      customPkgCheckbox.disabled = true;
      customPkgRow.classList.add('feature-locked');
      customPkgCheckbox.checked = false;
      packageNameWrapper.classList.add('hidden');
    }

    // GPS & Push -> Pro & Premium (level >= 2)
    const gpsCheckbox = document.getElementById('gpsCheckbox');
    const pushCheckbox = document.getElementById('pushCheckbox');
    const gpsRow = gpsCheckbox.closest('.feature-row');
    const pushRow = pushCheckbox.closest('.feature-row');

    if (level >= TIER_LEVEL.pro) {
      gpsCheckbox.disabled = false;
      pushCheckbox.disabled = false;
      gpsRow.classList.remove('feature-locked');
      pushRow.classList.remove('feature-locked');
    } else {
      gpsCheckbox.disabled = true;
      pushCheckbox.disabled = true;
      gpsCheckbox.checked = false;
      pushCheckbox.checked = false;
      gpsRow.classList.add('feature-locked');
      pushRow.classList.add('feature-locked');
    }
  }

  // =============================================
  // EVENT LISTENERS
  // =============================================
  function setupEventListeners() {
    // Logout
    document.getElementById('logoutBtn').addEventListener('click', async (e) => {
      e.preventDefault();
      await Web2AppAuth.signOut();
    });

    // Color picker sync
    const colorPicker = document.querySelector('input[type="color"][name="primary_color"]');
    const colorText = document.querySelector('input[name="primary_color_text"]');
    colorPicker.addEventListener('input', (e) => {
      colorText.value = e.target.value.toUpperCase();
    });
    colorText.addEventListener('input', (e) => {
      if (/^#[0-9A-Fa-f]{6}$/.test(e.target.value)) {
        colorPicker.value = e.target.value;
      }
    });

    // Custom Package Name toggle
    const customPkgCheckbox = document.getElementById('customPkgCheckbox');
    const packageNameWrapper = document.getElementById('packageNameWrapper');
    const packageNameInput = document.getElementById('packageNameInput');

    customPkgCheckbox.addEventListener('change', (e) => {
      if (e.target.checked) {
        packageNameWrapper.classList.remove('hidden');
        packageNameInput.required = true;
      } else {
        packageNameWrapper.classList.add('hidden');
        packageNameInput.required = false;
        packageNameInput.value = '';
      }
    });

    // Form submit
    document.getElementById('buildForm').addEventListener('submit', handleBuildSubmit);

    // Refresh history
    document.getElementById('refreshHistoryBtn').addEventListener('click', loadBuildHistory);
  }

  // =============================================
  // BUILD SUBMIT
  // =============================================
  async function handleBuildSubmit(e) {
    e.preventDefault();
    if (state.isBuilding) return;

    const form = e.target;
    const formData = new FormData(form);

    // Validasi quota/token sebelum submit
    const wallet = state.wallet;
    if (!wallet) {
      Web2AppUI.showToast('Wallet belum dimuat. Tunggu sebentar.', 'error');
      return;
    }

    const tier = wallet.subscription_tier || 'none';
    const isPaid = tier !== 'none';
    if (!isPaid && (wallet.token_balance || 0) < 1) {
      Web2AppUI.showModal({
        title: 'Token Tidak Cukup',
        content: `
          <p>Anda memiliki <strong>0 token</strong>. Silakan top-up atau berlangganan.</p>
          <p class="text-sm font-bold text-gray-700 mt-2">1 build = 1 token (Rp 500)</p>
        `,
        footer: `<a href="pricing.html" class="btn-nb btn-nb-primary w-full justify-center"><span data-icon="currency-dollar" class="h-5 w-5"></span> TOP-UP SEKARANG</a>`,
      });
      return;
    }

    // Build payload
    const payload = {
      project_name: formData.get('project_name'),
      app_name: formData.get('app_name'),
      website_url: formData.get('website_url'),
      app_icon_url: formData.get('app_icon_url') || undefined,
      primary_color: colorText.value,
      enable_gps: formData.get('enable_gps') === 'on',
      enable_push: formData.get('enable_push') === 'on',
      enable_offline: formData.get('enable_offline') === 'on',
    };

    if (formData.get('custom_package_enabled') === 'on' && formData.get('package_name')) {
      payload.package_name = formData.get('package_name');
    }

    // Start build
    state.isBuilding = true;
    const btn = document.getElementById('buildBtn');
    Web2AppUI.setButtonLoading(btn, true);
    document.getElementById('buildProgress').classList.remove('hidden');
    document.getElementById('progressText').textContent = 'Queueing build job...';

    try {
      const res = await Web2AppAPI.createBuild(payload);
      const jobId = res.data.job_id;

      Web2AppUI.showToast(`Build queued! Priority: ${res.data.priority}`, 'success');
      Web2AppUI.setProgress(10);
      document.getElementById('progressText').textContent = `Job ID: ${jobId.slice(0, 8)}... Polling status...`;

      // Poll status
      await pollBuildStatus(jobId);

      // Refresh wallet (token/quota decreased)
      await loadWallet();
      await loadBuildHistory();
    } catch (err) {
      console.error('[build] failed:', err);
      Web2AppUI.showToast(
        err.code === 'FEATURE_NOT_ALLOWED'
          ? `<span data-icon="x-circle" class="h-5 w-5"></span> ${err.message}`
          : `Build gagal: ${err.message}`,
        'error',
        6000
      );
    } finally {
      state.isBuilding = false;
      Web2AppUI.setButtonLoading(btn, false);
      document.getElementById('buildProgress').classList.add('hidden');
      Web2AppUI.setProgress(0);
    }
  }

  // =============================================
  // POLL BUILD STATUS
  // =============================================
  async function pollBuildStatus(jobId) {
    const maxAttempts = 60; // 60 * 3s = 3 menit
    let attempt = 0;

    while (attempt < maxAttempts) {
      attempt++;
      Web2AppUI.setProgress(10 + (attempt / maxAttempts) * 80);

      try {
        const res = await Web2AppAPI.getBuildStatus(jobId);
        const status = res.data.status;

        document.getElementById('progressText').textContent =
          `Status: ${status.toUpperCase()} (${attempt}/${maxAttempts})`;

        if (status === 'success') {
          Web2AppUI.setProgress(100);
          Web2AppUI.showToast('<span data-icon="sparkles" class="h-5 w-5"></span> APK berhasil di-build! Cek email Anda.', 'success', 6000);
          showBuildSuccessModal(res.data);
          return;
        }

        if (status === 'failed') {
          Web2AppUI.setProgress(0);
          Web2AppUI.showModal({
            title: 'Build Gagal',
            content: `
              <div class="alert-nb alert-nb-error">
                <span class="text-2xl"><span data-icon="x-circle" class="h-5 w-5"></span></span>
                <div>
                  <p class="font-bold m-0">${Web2AppUI.escapeHtml(res.data.error_message || 'Unknown error')}</p>
                </div>
              </div>
              <p class="text-sm font-bold mt-3">Token Anda sudah di-refund otomatis.</p>
            `,
            footer: `<button data-modal-close class="btn-nb w-full justify-center">TUTUP</button>`,
          });
          return;
        }

        if (status === 'cancelled' || status === 'expired') {
          return;
        }

        // Still queued/processing — wait 3s
        await new Promise((r) => setTimeout(r, 3000));
      } catch (err) {
        console.error('[poll] error:', err);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    Web2AppUI.showToast('Build timeout. Cek dashboard untuk status terbaru.', 'warning');
  }

  // =============================================
  // BUILD SUCCESS MODAL
  // =============================================
  function showBuildSuccessModal(data) {
    const content = `
      <div class="space-y-4">
        <div class="alert-nb alert-nb-success">
          <span class="text-3xl"><span data-icon="sparkles" class="h-5 w-5"></span></span>
          <div>
            <p class="font-black m-0 text-lg">Build berhasil!</p>
            <p class="text-sm font-bold m-0">APK siap didownload</p>
          </div>
        </div>

        <div class="border-3 border-black p-4 space-y-2">
          <div class="flex justify-between font-bold">
            <span>App Name</span>
            <span>${Web2AppUI.escapeHtml(data.app_name)}</span>
          </div>
          <div class="flex justify-between font-bold">
            <span>Ukuran</span>
            <span>${(data.apk_size_bytes / 1024).toFixed(1)} KB</span>
          </div>
          <div class="flex justify-between font-bold">
            <span>Durasi</span>
            <span>${(data.duration_ms / 1000).toFixed(1)}s</span>
          </div>
          <div class="flex justify-between font-bold">
            <span>Expired</span>
            <span>${Web2AppUI.formatDate(data.expires_at)}</span>
          </div>
        </div>
      </div>
    `;

    const footer = `
      <div class="flex gap-3">
        <a href="${data.apk_url}" target="_blank" class="btn-nb btn-nb-primary flex-1 justify-center">
          <span data-icon="arrow-down-tray" class="h-5 w-5"></span> DOWNLOAD APK
        </a>
        <button data-modal-close class="btn-nb flex-1 justify-center">TUTUP</button>
      </div>
    `;

    Web2AppUI.showModal({ title: '<span data-icon="check-circle" class="h-5 w-5"></span> Build Selesai', content, footer });
  }

  // =============================================
  // BUILD HISTORY
  // =============================================
  async function loadBuildHistory() {
    const container = document.getElementById('buildHistory');
    container.innerHTML = `<p class="font-bold text-sm text-gray-700 text-center py-8">Loading...</p>`;

    try {
      const res = await Web2AppAPI.listBuilds({ limit: 10 });
      const builds = res.data || [];

      if (builds.length === 0) {
        container.innerHTML = `
          <div class="text-center py-8">
            <div class="text-5xl mb-2"><span data-icon="cube" class="h-5 w-5"></span></div>
            <p class="font-bold text-sm text-gray-700">Belum ada build history</p>
            <p class="text-xs font-bold text-gray-500">Yuk build APK pertama kamu!</p>
          </div>
        `;
        return;
      }

      container.innerHTML = builds.map(renderBuildCard).join('');
    } catch (err) {
      container.innerHTML = `<p class="font-bold text-sm text-red-600 text-center py-8">Gagal memuat history</p>`;
    }
  }

  function renderBuildCard(build) {
    const statusColors = {
      success: 'green-400',
      failed: 'red-400',
      queued: 'yellow-300',
      processing: 'cyan-300',
      cancelled: 'gray-300',
      expired: 'gray-300',
    };
    const statusIcons = {
      success: '<span data-icon="check-circle" class="h-5 w-5"></span>',
      failed: '<span data-icon="x-circle" class="h-5 w-5"></span>',
      queued: '<span data-icon="clock" class="h-5 w-5 inline-block"></span>',
      processing: '<span data-icon="info" class="h-5 w-5"></span>',
      cancelled: '<span data-icon="ban" class="h-5 w-5"></span>',
      expired: '<span data-icon="clock" class="h-5 w-5 inline-block"></span>',
    };

    const bg = statusColors[build.status] || 'gray-300';
    const icon = statusIcons[build.status] || '<span data-icon="question" class="h-5 w-5"></span>';
    const appName = build.app_configs?.app_name || 'Unknown';

    return `
      <div class="border-3 border-black p-3 hover:bg-yellow-50 cursor-pointer transition-colors" onclick="window.location.href='/api/build/${build.id}'">
        <div class="flex items-start justify-between gap-2">
          <div class="flex-1 min-w-0">
            <p class="font-black text-sm m-0 truncate">${Web2AppUI.escapeHtml(appName)}</p>
            <p class="text-xs font-bold text-gray-700 m-0">${Web2AppUI.formatDate(build.created_at)}</p>
          </div>
          <div class="w-8 h-8 bg-${bg} border-2 border-black flex items-center justify-center text-sm font-black flex-shrink-0">
            ${icon}
          </div>
        </div>
        ${
          build.build_duration_ms
            ? `<p class="text-xs font-bold text-gray-600 mt-1">⏱ ${(build.build_duration_ms / 1000).toFixed(1)}s</p>`
            : ''
        }
      </div>
    `;
  }

  // =============================================
  // BOOT
  // =============================================
  document.addEventListener('DOMContentLoaded', init);

// =============================================
// PROXY FALLBACK
// =============================================

/**
 * Fallback: pakai backend proxy untuk bypass X-Frame-Options
 */
function tryProxyFallback(originalUrl) {
  const proxyUrl = window.API_BASE_URL + '/preview?url=' + encodeURIComponent(originalUrl);
  const iframe = document.getElementById('previewIframe');
  if (!iframe) return;

  showState('loading');

  fetch(proxyUrl, { method: 'GET' })
    .then((res) => {
      if (!res.ok) throw new Error('Proxy returned ' + res.status);
      return res.text();
    })
    .then((html) => {
      // Pakai srcdoc untuk inject HTML langsung (bypass X-Frame-Options)
      iframe.srcdoc = html;
      iframe.removeAttribute('src');
      showState('iframe');
    })
    .catch((err) => {
      console.warn('[preview] proxy fallback failed:', err.message);
      // Tetap show blocked (proxy juga gagal, e.g. timeout / non-HTML)
      showState('blocked');
    });
}

// =============================================
// LIVE PREVIEW (iframe real-time)
// =============================================
function initLivePreview() {
  const urlInput = document.querySelector('input[name="website_url"]');
  const refreshBtn = document.getElementById('refreshPreviewBtn');
  const iframe = document.getElementById('previewIframe');
  const states = {
    empty: document.getElementById('previewEmpty'),
    loading: document.getElementById('previewLoading'),
    blocked: document.getElementById('previewBlocked'),
    error: document.getElementById('previewError'),
  };

  if (!urlInput || !iframe) return;

  let debounceTimer = null;
  let lastLoadedUrl = '';

  function showState(name) {
    // Hide all states
    Object.values(states).forEach((el) => el && el.classList.add('hidden'));
    iframe.classList.add('hidden');

    if (name === 'iframe') {
      iframe.classList.remove('hidden');
    } else if (states[name]) {
      states[name].classList.remove('hidden');
    }
  }

  function isValidUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function loadPreview(url) {
    if (!url || !isValidUrl(url)) {
      showState('empty');
      return;
    }

    // Same URL? Skip
    if (url === lastLoadedUrl) return;
    lastLoadedUrl = url;

    showState('loading');

    // Clear previous iframe
    iframe.src = 'about:blank';

    // Timeout fallback (kalau iframe gak load dalam 8 detik)
    const loadTimeout = setTimeout(() => {
      if (!iframe.contentDocument && iframe.classList.contains('hidden')) {
        showState('error');
        const errorMsg = document.getElementById('previewErrorMsg');
        if (errorMsg) errorMsg.textContent = 'Timeout: website tidak merespons.';
      }
    }, 8000);

    // Set iframe src
    iframe.onload = () => {
      clearTimeout(loadTimeout);
      try {
        // Cek apakah iframe bisa akses (kalau blocked, akan throw error)
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (doc && doc.body && doc.body.innerHTML.trim() !== '') {
          showState('iframe');
        } else {
          // Body kosong → likely X-Frame-Options blocked, coba proxy
          tryProxyFallback(url);
        }
      } catch (e) {
        // Cross-origin error = website block iframe
        // Fallback ke backend proxy
        tryProxyFallback(url);
      }
    };

    iframe.onerror = () => {
      clearTimeout(loadTimeout);
      showState('error');
    };

    iframe.src = url;
  }

  // Real-time update dengan debounce
  urlInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      loadPreview(urlInput.value.trim());
    }, 800);
  });

  // Refresh button
  if (refreshBtn) {
    refreshBtn.addEventListener('click', (e) => {
      e.preventDefault();
      lastLoadedUrl = ''; // force reload
      loadPreview(urlInput.value.trim());
    });
  }

  // Initial state
  const initialUrl = urlInput.value.trim();
  if (initialUrl && isValidUrl(initialUrl)) {
    loadPreview(initialUrl);
  } else {
    showState('empty');
  }
}


  // Init live preview setelah DOM ready
  initLivePreview();
})();