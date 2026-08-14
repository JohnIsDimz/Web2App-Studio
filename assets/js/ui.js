/**
 * Web2App Studio - UI Helpers
 * ============================================
 * Fungsi utilitas untuk manipulasi DOM dengan gaya Neobrutalism.
 * Vanilla JS, no framework.
 */

// =============================================
// Toast / Alert System
// =============================================
function showToast(message, type = 'info', duration = 4000) {
  // Remove existing
  document.querySelectorAll('.toast-nb').forEach((t) => t.remove());

  const toast = document.createElement('div');
  toast.className = `toast-nb alert-nb alert-nb-${type} fixed top-4 right-4 z-50 max-w-sm shadow-nb-lg`;
  toast.style.animation = 'slideInRight 0.3s ease-out';

  const icon = {
    success: '<span data-icon="check" class="h-5 w-5"></span>',
    error: '<span data-icon="x" class="h-5 w-5"></span>',
    warning: '<span data-icon="exclamation" class="h-5 w-5"></span>',
    info: 'ℹ',
  }[type] || 'ℹ';

  toast.innerHTML = `
    <span class="text-2xl font-black">${icon}</span>
    <div class="flex-1">
      <p class="m-0 text-sm font-bold">${escapeHtml(message)}</p>
    </div>
    <button class="ml-2 font-black text-xl leading-none" onclick="this.parentElement.remove()">×</button>
  `;

  document.body.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }
}

// =============================================
// Modal
// =============================================
function showModal({ title, content, footer, onClose, maxWidth = '500px' }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop-nb';
  backdrop.innerHTML = `
    <div class="modal-nb" style="max-width: ${maxWidth};">
      <div class="flex items-center justify-between p-6 border-b-3 border-black bg-yellow-200">
        <h3 class="heading-nb text-2xl m-0">${escapeHtml(title)}</h3>
        <button class="btn-nb btn-nb-sm !p-2 !w-10 !h-10" data-modal-close>×</button>
      </div>
      <div class="p-6">${content}</div>
      ${footer ? `<div class="p-6 border-t-3 border-black bg-gray-50">${footer}</div>` : ''}
    </div>
  `;

  document.body.appendChild(backdrop);

  const close = () => {
    backdrop.style.opacity = '0';
    setTimeout(() => {
      backdrop.remove();
      onClose?.();
    }, 200);
  };

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector('[data-modal-close]').addEventListener('click', close);

  // ESC to close
  const escHandler = (e) => {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);

  return { close, element: backdrop };
}

/**
 * Confirm dialog — returns Promise<boolean>
 *
 * Usage:
 *   const ok = await Web2AppUI.confirmDialog({
 *     title: 'Hapus?',
 *     message: 'Yakin hapus data ini?',
 *     confirmText: 'HAPUS',
 *     cancelText: 'BATAL',
 *     type: 'danger', // 'danger' | 'info' | 'warning'
 *   });
 */
function confirmDialog({ title, message, confirmText = 'OK', cancelText = 'BATAL', type = 'info' }) {
  return new Promise((resolve) => {
    const colorMap = {
      danger: 'btn-nb-danger',
      warning: 'btn-nb-warning',
      info: 'btn-nb-info',
      success: 'btn-nb-success',
    };
    const confirmClass = colorMap[type] || 'btn-nb-primary';

    const content = `
      <div class="space-y-3">
        <p class="font-bold text-base whitespace-pre-line">${escapeHtml(message)}</p>
      </div>
    `;

    const footer = `
      <div class="flex gap-2">
        <button id="confirmCancel" class="btn-nb flex-1 justify-center">${escapeHtml(cancelText)}</button>
        <button id="confirmOk" class="btn-nb ${confirmClass} flex-1 justify-center">${escapeHtml(confirmText)}</button>
      </div>
    `;

    const modal = showModal({ title, content, footer, maxWidth: '420px' });

    document.getElementById('confirmOk').addEventListener('click', () => {
      modal.close();
      resolve(true);
    });
    document.getElementById('confirmCancel').addEventListener('click', () => {
      modal.close();
      resolve(false);
    });

    // ESC = cancel
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        modal.close();
        document.removeEventListener('keydown', escHandler);
        resolve(false);
      }
    };
    document.addEventListener('keydown', escHandler);
  });
}

// =============================================
// Progress Bar
// =============================================
function setProgress(percent) {
  const fill = document.querySelector('.progress-nb-fill');
  if (fill) {
    fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  }
}

function showIndeterminateProgress() {
  const containers = document.querySelectorAll('.progress-container');
  containers.forEach((c) => {
    c.innerHTML = `
      <div class="progress-nb progress-nb-indeterminate">
        <div class="progress-nb-fill"></div>
      </div>
    `;
  });
}

// =============================================
// Loading State untuk Button
// =============================================
function setButtonLoading(button, loading = true) {
  if (!button) return;
  if (loading) {
    button.dataset.originalText = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spinner-nb"></span> LOADING...`;
    button.classList.add('opacity-75');
  } else {
    button.disabled = false;
    button.innerHTML = button.dataset.originalText || button.innerHTML;
    button.classList.remove('opacity-75');
  }
}

// =============================================
// Format Currency (IDR)
// =============================================
function formatIDR(amount) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatNumber(n) {
  return new Intl.NumberFormat('id-ID').format(n);
}

// =============================================
// Format Date
// =============================================
function formatDate(isoString, options = {}) {
  if (!isoString) return '-';
  const date = new Date(isoString);
  return date.toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...options,
  });
}

// =============================================
// Escape HTML (prevent XSS)
// =============================================
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// =============================================
// Polling helper
// =============================================
async function pollUntil(fn, options = {}) {
  const {
    interval = 2000,
    maxAttempts = 30,
    onProgress,
  } = options;

  for (let i = 0; i < maxAttempts; i++) {
    const result = await fn();
    onProgress?.(result, i);

    if (result?.done) return result;
    if (result?.shouldStop) break;

    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error('Polling timeout');
}

// =============================================
// WELCOME MODAL — Personalized per User
// =============================================
// 1 template solid per kategori (new/returning).
// Personalisasi via data user (nama, tier, tokens, waktu, dst).
// Konsisten — bukan gacha random.
//
// isNewUser=true  → setelah signup
// isNewUser=false → setiap buka dashboard
function showWelcomeModal({ name, email, isNewUser = true, onClose }) {
  // ============================================
  // Personalisasi (1 template, banyak variasi)
  // ============================================
  
  // 1. Bersihkan nama: "joo" → "Joo", "JOHN DOE" → "John Doe"
  const cleanName = String(name || 'Sobat')
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ') || 'Sobat';

  // 2. Hitung umur akun (untuk user baru)
  let accountAge = '';
  let firstName = cleanName.split(' ')[0]; // "John Doe Smith" → "John"
  if (isNewUser) {
    accountAge = 'fresh'; // placeholder
  } else {
    // Ambil dari state.dashboardState kalau ada
    const userCreatedAt = window.dashboardState?.user?.created_at;
    if (userCreatedAt) {
      const days = Math.floor((new Date() - new Date(userCreatedAt)) / (1000 * 60 * 60 * 24));
      if (days === 0) accountAge = 'hari ini';
      else if (days === 1) accountAge = '1 hari';
      else if (days < 7) accountAge = `${days} hari`;
      else if (days < 30) accountAge = `${Math.floor(days / 7)} minggu`;
      else if (days < 365) accountAge = `${Math.floor(days / 30)} bulan`;
      else accountAge = `${Math.floor(days / 365)} tahun`;
    }
  }

  // 3. Greeting by time
  const hour = new Date().getHours();
  const timeGreeting =
    hour < 11 ? 'pagi' :
    hour < 15 ? 'siang' :
    hour < 18 ? 'sore' :
                'malam';

  // 4. Tier label & emoji
  const tier = window.dashboardState?.wallet?.subscription_tier || 'none';
  const tierInfo = {
    none:    { label: 'Free Trial',  badge: '🎁', desc: 'lagi coba-coba' },
    basic:   { label: 'Basic',        badge: '📦', desc: 'lagi aktif' },
    pro:     { label: 'Pro',          badge: '🚀', desc: 'lagi produktif' },
    premium: { label: 'Premium',      badge: '👑', desc: 'lagi top-tier' },
  }[tier];

  // 5. Token info
  const tokens = window.dashboardState?.wallet?.token_balance || 0;
  const tokenInfo = tokens === 0
    ? 'token kamu habis — siap top-up?'
    : tokens <= 1
      ? 'tersisa 1 token lagi — hemat ya'
      : `ada ${tokens} token tersedia`;

  // 6. First name only (untuk casual greeting)
  const shortName = firstName;

  // ============================================
  // TEMPLATE: User Baru (signup)
  // ============================================
  // 1 template solid, BUKAN gacha. Personalisasi via:
  //   - firstName (casual)
  //   - tier (kalau signup PRO langsung welcome beda)
  //   - token bonus
  //   - email (display only)
  // ============================================
  const newUserTemplate = `
    <div class="space-y-4">
      <!-- Hero icon -->
      <div class="text-center">
        <div class="w-20 h-20 bg-yellow-300 border-3 border-black flex items-center justify-center mx-auto shadow-nb">
          <span data-icon="award" class="h-12 w-12"></span>
        </div>
      </div>

      <!-- Headline (personalized) -->
      <div class="text-center">
        <p class="text-xl font-black m-0">Selamat datang, <strong>${escapeHtml(cleanName)}</strong>! 👋</p>
        <p class="text-sm font-bold text-gray-700 m-0 mt-2">
          Akun kamu sudah aktif. Sekarang tinggal buktiin ide kamu bisa jadi APK beneran.
        </p>
      </div>

      <!-- Account Info -->
      <div class="bg-gray-50 border-3 border-black p-3">
        <div class="flex items-center gap-2 text-sm font-bold">
          <span data-icon="mail" class="h-5 w-5 flex-shrink-0"></span>
          <span class="truncate">${escapeHtml(email)}</span>
        </div>
        ${
          tier !== 'none'
            ? `<div class="flex items-center gap-2 text-sm font-bold mt-2">
                 <span>${tierInfo.badge}</span>
                 <span>Tier: ${tierInfo.label}</span>
               </div>`
            : ''
        }
      </div>

      <!-- What's next -->
      <div class="bg-blue-50 border-3 border-black p-3">
        <p class="font-black text-sm m-0">💡 Cara bikin APK pertama kamu:</p>
        <ol class="text-xs font-bold mt-2 space-y-1 pl-4 m-0 list-decimal">
          <li>Isi nama app & URL website</li>
          <li>Pilih warna & icon (atau skip)</li>
          <li>Klik "Build APK" — kelar dalam 1-5 menit</li>
        </ol>
      </div>

      <!-- Friendly tip untuk free trial -->
      ${
        tier === 'none'
          ? `<div class="bg-yellow-100 border-3 border-black p-3">
               <p class="text-xs font-bold m-0">
                 <span data-icon="gift" class="h-5 w-5"></span>
                 <strong>Bonus:</strong> Kamu dapat ${tokens} token gratis buat coba-coba.
                 Token di-refund otomatis kalau build gagal.
               </p>
             </div>`
          : ''
      }
    </div>
  `;

  // ============================================
  // TEMPLATE: User Lama (setiap buka dashboard)
  // ============================================
  // 1 template solid, personalized via:
  //   - firstName (casual)
  //   - timeGreeting (pagi/siang/sore/malam)
  //   - tier (status langganan)
  //   - tokens (sisa)
  //   - accountAge (berapa lama terdaftar)
  // ============================================
  const returningUserTemplate = `
    <div class="space-y-4">
      <!-- Hero icon -->
      <div class="text-center">
        <div class="w-20 h-20 bg-cyan-300 border-3 border-black flex items-center justify-center mx-auto shadow-nb">
          <span data-icon="user-check" class="h-12 w-12"></span>
        </div>
      </div>

      <!-- Headline (personalized by time + name) -->
      <div class="text-center">
        <p class="text-xl font-black m-0">
          Selamat ${timeGreeting}, <strong>${escapeHtml(shortName)}</strong>! ${tierInfo.badge}
        </p>
        <p class="text-sm font-bold text-gray-700 m-0 mt-2">
          ${tierInfo.desc === 'lagi coba-coba'
            ? 'Senang liat kamu balik. Yuk lanjut eksplorasi Web2App Studio.'
            : 'Yuk lanjut karya terbaikmu. Hari ini mau bikin apa?'}
        </p>
      </div>

      <!-- Account Status (3 cards) -->
      <div class="grid grid-cols-2 gap-2">
        <div class="bg-yellow-100 border-3 border-black p-3 text-center">
          <p class="text-xs font-black uppercase text-gray-700">Status</p>
          <p class="text-base font-black" id="welcomeTierName">${tierInfo.label}</p>
        </div>
        <div class="bg-gray-50 border-3 border-black p-3 text-center">
          <p class="text-xs font-black uppercase text-gray-700">Member</p>
          <p class="text-base font-black">${accountAge || '–'}</p>
        </div>
      </div>

      <div class="bg-gray-50 border-3 border-black p-3 grid grid-cols-2 gap-3 text-center">
        <div>
          <p class="text-xs font-black uppercase text-gray-700">Tokens</p>
          <p class="text-2xl font-black" id="welcomeTokens">${tokens}</p>
        </div>
        <div>
          <p class="text-xs font-black uppercase text-gray-700">Quota</p>
          <p class="text-2xl font-black" id="welcomeQuota">–</p>
        </div>
      </div>

      <!-- Contextual message -->
      ${
        tokens === 0 && tier === 'none'
          ? `<div class="bg-red-100 border-3 border-black p-3">
               <p class="text-xs font-bold m-0">
                 <span data-icon="alert-triangle" class="h-5 w-5"></span>
                 Token kamu habis. Tambah token atau berlangganan buat lanjut build.
               </p>
             </div>`
          : tokens <= 1 && tier === 'none'
          ? `<div class="bg-orange-100 border-3 border-black p-3">
               <p class="text-xs font-bold m-0">
                 <span data-icon="alert-circle" class="h-5 w-5"></span>
                 Tinggal 1 token. Mungkin mikirin top-up atau langganan?
               </p>
             </div>`
          : ''
      }

      <!-- Soft upsell (kalau bukan premium) -->
      ${
        tier !== 'premium'
          ? `<div class="bg-purple-100 border-3 border-black p-3">
               <p class="font-black text-sm m-0">🚀 Mau unlock lebih banyak?</p>
               <p class="text-xs font-bold mt-1 m-0">
                 Upgrade ke <strong>Pro</strong> atau <strong>Premium</strong> untuk GPS, push notification, dan custom package name.
               </p>
             </div>`
          : `<div class="bg-green-100 border-3 border-black p-3">
               <p class="text-xs font-bold m-0">
                 <span data-icon="check-circle" class="h-5 w-5"></span>
                 <strong>VIP status aktif.</strong> Nikmati semua fitur Premium.
               </p>
             </div>`
      }
    </div>
  `;

  // Footer dengan CTA contextual
  const footer = isNewUser
    ? `<button data-modal-close class="btn-nb btn-nb-primary w-full justify-center text-base py-3">
         <span data-icon="rocket" class="h-5 w-5"></span> Sip, ayo mulai!
       </button>`
    : `<div class="flex gap-2">
         <button data-modal-close class="btn-nb flex-1 justify-center">
           Nanti aja
         </button>
         <button data-modal-close class="btn-nb btn-nb-primary flex-1 justify-center" id="welcomeLanjutBtn">
           <span data-icon="paint-brush" class="h-5 w-5"></span> Lanjut Build
         </button>
       </div>`;

  const title = isNewUser
    ? 'Selamat Datang! 🎉'
    : `${timeGreeting.charAt(0).toUpperCase() + timeGreeting.slice(1)}, ${shortName}!`;

  const modal = showModal({
    title,
    content: isNewUser ? newUserTemplate : returningUserTemplate,
    footer,
    onClose,
    maxWidth: '480px',
  });

  // Auto-render icon di modal
  if (window.Web2AppIcons || window.Web2AppFeather) {
    setTimeout(() => {
      if (window.Web2AppFeather) Web2AppFeather.autoRender(modal.element);
      if (window.Web2AppIcons) Web2AppIcons.autoRender(modal.element);
    }, 50);
  }

  // Untuk returning user: populate quota dari state.wallet
  if (!isNewUser && window.dashboardState?.wallet) {
    const wallet = window.dashboardState.wallet;
    const limit = wallet.build_quota_limit || 0;
    const used = wallet.build_quota_used || 0;
    const quotaEl = document.getElementById('welcomeQuota');
    if (quotaEl) quotaEl.textContent = limit === 0 ? `${used}/∞` : `${used}/${limit}`;
  }

  return modal;
}


window.Web2AppUI = {
  showToast,
  showModal,
  confirmDialog,
  showWelcomeModal,  // Welcome popup (signup / dashboard load)
  setProgress,
  showIndeterminateProgress,
  setButtonLoading,
  formatIDR,
  formatNumber,
  formatDate,
  escapeHtml,
  pollUntil,
};
