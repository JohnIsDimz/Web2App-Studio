/**
 * ============================================
 * PRICING PAGE LOGIC (SISTEM FINAL)
 * ============================================
 * Tab structure:
 *   1. Deposit Saldo  (default) → user top up saldo via QRIS
 *   2. Beli Token     → info redirect ke convert.html (produk terpisah)
 *   3. Langganan      → langsung pakai saldo, instant
 *
 * Sistem FINAL:
 *   - Top up saldo → user top up uang via Pakasir QRIS
 *   - Beli token (PRODUK) → potong saldo instant (convert.html)
 *   - Subscribe (PRODUK) → potong saldo instant
 *
 * TIDAK ADA beli token pakai QRIS langsung.
 * HARUS lewat saldo.
 * ============================================
 */

(function () {
  'use strict';

  if (window.Web2AppAuth) Web2AppAuth.initSupabase();

  // =============================================
  // STATE
  // =============================================
  const TIER_PRICES = {
    basic: 15000,
    pro: 30000,
    premium: 60000,
  };

  let currentWallet = null;

  // =============================================
  // 1. TAB SWITCHING
  // =============================================
  function setupTabs() {
    const tabs = document.querySelectorAll('[data-tab]');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.tab;

        // Update tab visual
        tabs.forEach((t) => t.classList.remove('tab-nb-active'));
        tab.classList.add('tab-nb-active');

        // Show/hide content
        document.querySelectorAll('.tab-content').forEach((el) => el.classList.add('hidden'));
        const targetEl = document.getElementById(`tab-${target}`);
        if (targetEl) targetEl.classList.remove('hidden');

        // Kalau tab token, refresh balance info
        if (target === 'token') {
          updateTokenTabInfo();
        }
      });
    });
  }

  // =============================================
  // 2. TOKEN TAB INFO (balance + equivalent)
  // =============================================
  async function updateTokenTabInfo() {
    if (!currentWallet) {
      currentWallet = await Web2AppAPI.getMyWallet();
    }
    if (!currentWallet) return;

    const balance = currentWallet.balance_idr || 0;
    const tokens = Math.floor(balance / 500);
    const balEl = document.getElementById('tokenTabCurrentBalance');
    const equivEl = document.getElementById('tokenTabEquivalent');
    if (balEl) balEl.textContent = Web2AppUI.formatIDR(balance);
    if (equivEl) equivEl.textContent = tokens;
  }

  // =============================================
  // 3. SUBSCRIPTION FLOW
  // =============================================
  /**
   * Subscribe flow (FINAL):
   * 1. Cek saldo user
   * 2. Kalau saldo >= harga tier → konfirmasi & panggil buySubscriptionWithSaldo
   *    (instant, no QRIS)
   * 3. Kalau saldo kurang → minta topup dulu
   */
  async function subscribeTo(tier) {
    const session = await checkAuth();
    if (!session) {
      Web2AppUI.showToast('Silakan login terlebih dahulu', 'warning');
      setTimeout(() => (window.location.href = 'login.html'), 1500);
      return;
    }

    const tierPrice = TIER_PRICES[tier];
    if (!tierPrice) {
      Web2AppUI.showToast('Tier tidak valid', 'error');
      return;
    }

    if (!currentWallet) {
      currentWallet = await Web2AppAPI.getMyWallet();
    }
    const currentBalance = currentWallet?.balance_idr || 0;

    if (currentBalance >= tierPrice) {
      // Saldo cukup → konfirmasi + activate instant
      const sisa = currentBalance - tierPrice;
      const confirmed = await Web2AppUI.confirmDialog({
        title: `Berlangganan ${tier.toUpperCase()}?`,
        message: `Harga: ${Web2AppUI.formatIDR(tierPrice)}/bulan\nSaldo Anda: ${Web2AppUI.formatIDR(currentBalance)}\nSisa saldo: ${Web2AppUI.formatIDR(sisa)}\n\nTier ${tier.toUpperCase()} langsung aktif selama 30 hari.`,
        confirmText: 'BAYAR PAKAI SALDO',
        cancelText: 'BATAL',
        type: 'success',
      });

      if (!confirmed) return;

      try {
        const res = await Web2AppAPI.buySubscriptionWithSaldo({ tier });
        const d = res.data;
        Web2AppUI.showToast(
          `Berhasil! Tier ${d.tier.toUpperCase()} aktif sampai ${Web2AppUI.formatDate(d.expiresAt)}.`,
          'success',
          6000
        );
        setTimeout(() => (window.location.href = 'dashboard.html'), 2000);
      } catch (err) {
        Web2AppUI.showToast('Subscription gagal: ' + err.message, 'error');
      }
    } else {
      // Saldo kurang → minta topup
      const kurang = tierPrice - currentBalance;
      const confirmed = await Web2AppUI.confirmDialog({
        title: 'Saldo Tidak Cukup',
        message: `Saldo Anda: ${Web2AppUI.formatIDR(currentBalance)}\nHarga ${tier.toUpperCase()}: ${Web2AppUI.formatIDR(tierPrice)}\nKurang: ${Web2AppUI.formatIDR(kurang)}\n\nTop up saldo dulu? Minimal ${Web2AppUI.formatIDR(kurang)} supaya cukup.`,
        confirmText: 'TOPUP SEKARANG',
        cancelText: 'BATAL',
        type: 'warning',
      });

      if (!confirmed) return;

      switchToDepositTab(kurang);
    }
  }

  /**
   * Switch ke deposit tab dengan pre-filled amount
   */
  function switchToDepositTab(amount) {
    const tabs = document.querySelectorAll('[data-tab]');
    tabs.forEach((t) => t.classList.remove('tab-nb-active'));
    document.querySelector('[data-tab="deposit"]')?.classList.add('tab-nb-active');

    document.querySelectorAll('.tab-content').forEach((el) => el.classList.add('hidden'));
    document.getElementById('tab-deposit')?.classList.remove('hidden');

    // Set amount
    const input = document.getElementById('depositCustomAmount');
    if (input) {
      input.value = amount;
      input.dispatchEvent(new Event('input'));
    }
  }

  // =============================================
  // 4. CHECK AUTH
  // =============================================
  async function checkAuth() {
    if (!window.Web2AppAuth) return null;
    return await window.Web2AppAuth.getSession();
  }

  // =============================================
  // 5. PAYMENT MODAL (shared)
  // =============================================
  function showPaymentModal({ orderId, amount, type, qrString, qrUrl, expiredAt, tokenAmount, targetTier }) {
    const titleText = type === 'subscription'
      ? `Bayar Subscription ${targetTier?.toUpperCase()}`
      : `Bayar ${tokenAmount} Token`;

    const content = `
      <div class="space-y-4">
        <div class="alert-nb alert-nb-warning">
          <span data-icon="clock" class="h-5 w-5 flex-shrink-0 mt-0.5"></span>
          <div>
            <p class="font-bold m-0">Selesaikan pembayaran sebelum 15 menit</p>
          </div>
        </div>

        <div class="text-center">
          <p class="text-sm font-bold text-gray-700 mb-2">SCAN QRIS</p>
          <div class="bg-white border-3 border-black p-4 inline-block">
            <canvas id="qrCanvas" width="240" height="240"></canvas>
          </div>
          <p class="text-xs font-bold text-gray-700 mt-3 break-all">Order ID: <code>${orderId}</code></p>
        </div>

        <div class="border-t-3 border-black pt-4 space-y-2">
          <div class="flex justify-between font-bold">
            <span>Total Bayar</span>
            <span class="text-xl font-black">${Web2AppUI.formatIDR(amount)}</span>
          </div>
        </div>

        <div class="bg-gray-50 border-3 border-black p-3 text-sm font-bold">
          <span data-icon="light-bulb" class="h-5 w-5 inline-block align-middle"></span>
          Buka e-wallet (GoPay/OVO/DANA/ShopeePay) → Scan QR di atas
        </div>
      </div>
    `;

    const footer = `
      <div class="flex gap-3">
        <button id="checkPaymentBtn" class="btn-nb btn-nb-success flex-1 justify-center">
          <span data-icon="check" class="h-5 w-5"></span> Cek Status
        </button>
        <button data-modal-close class="btn-nb flex-1 justify-center">Tutup</button>
      </div>
    `;

    const modal = Web2AppUI.showModal({ title: titleText, content, footer, maxWidth: '480px' });

    // Render QR placeholder
    setTimeout(() => {
      const canvas = document.getElementById('qrCanvas');
      if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#FFE066';
        ctx.fillRect(0, 0, 240, 240);
        ctx.fillStyle = '#000';
        ctx.font = 'bold 14px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('QR Code Here', 120, 110);
        ctx.fillText('(scan via e-wallet)', 120, 130);
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 4;
        ctx.strokeRect(2, 2, 236, 236);
      }
      if (window.Web2AppFeather) Web2AppFeather.autoRender();
    }, 100);

    document.getElementById('checkPaymentBtn').addEventListener('click', async () => {
      await checkTransactionStatus(orderId, type, targetTier, tokenAmount, modal);
    });

    // Auto-poll
    let pollAttempts = 0;
    const pollInterval = setInterval(async () => {
      pollAttempts++;
      if (pollAttempts > 60) {
        clearInterval(pollInterval);
        return;
      }
      const result = await pollStatusOnce(orderId);
      if (result.success) {
        clearInterval(pollInterval);
        modal.close();
        Web2AppUI.showToast(
          type === 'subscription'
            ? `Selamat! Akun Anda sekarang tier ${targetTier.toUpperCase()}.`
            : `${tokenAmount} token telah ditambahkan!`,
          'success',
          6000
        );
        setTimeout(() => (window.location.href = 'dashboard.html'), 2000);
      }
    }, 3000);

    const observer = new MutationObserver(() => {
      if (!document.querySelector('.modal-backdrop-nb')) {
        clearInterval(pollInterval);
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  async function pollStatusOnce(orderId) {
    try {
      const res = await Web2AppAPI.getTransactionStatus(orderId);
      return { success: res.data.status === 'success' };
    } catch {
      return { success: false };
    }
  }

  async function checkTransactionStatus(orderId, type, targetTier, tokenAmount, modal) {
    try {
      const res = await Web2AppAPI.getTransactionStatus(orderId);
      if (res.data.status === 'success') {
        modal.close();
        Web2AppUI.showToast('Pembayaran berhasil!', 'success');
        setTimeout(() => (window.location.href = 'dashboard.html'), 1500);
      } else if (res.data.status === 'pending') {
        Web2AppUI.showToast('Belum terbayar. Selesaikan scan QR dulu!', 'warning');
      } else {
        Web2AppUI.showToast(`Status: ${res.data.status}`, 'error');
      }
    } catch (err) {
      Web2AppUI.showToast('Gagal cek status: ' + err.message, 'error');
    }
  }

  // =============================================
  // 6. SUBSCRIPTION BUTTON HANDLERS
  // =============================================
  function setupSubscriptionButtons() {
    document.querySelectorAll('.subscribe-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tier = btn.dataset.tier;
        subscribeTo(tier);
      });
    });
  }

  // =============================================
  // 7. INIT
  // =============================================
  async function init() {
    setupTabs();
    setupSubscriptionButtons();

    // Pre-load wallet untuk tab token info
    if (window.Web2AppAuth) {
      const session = await window.Web2AppAuth.getSession();
      if (session) {
        currentWallet = await Web2AppAPI.getMyWallet();
        updateTokenTabInfo();
      }
    }

    // Handle hash untuk deep-link (pricing.html#subscription)
    const hash = window.location.hash;
    if (hash === '#subscription') {
      document.querySelector('[data-tab="subscription"]')?.click();
    } else if (hash === '#deposit') {
      document.querySelector('[data-tab="deposit"]')?.click();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
