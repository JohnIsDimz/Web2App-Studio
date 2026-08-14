/**
 * Web2App Studio - Deposit Tab Logic (di pricing.html)
 * ============================================
 * Tab Deposit di pricing.html
 *
 * Alur:
 *   1. User pilih nominal (preset 10K/20K/50K/100K/200K atau custom)
 *   2. Submit → POST /api/transactions/create (kind='saldo')
 *   3. Bayar QRIS Pakasir
 *   4. Webhook validasi → saldo masuk
 *   5. Frontend redirect ke convert.html / history.html dengan pilihan
 *
 * IMPORTANT: Setelah deposit sukses, JANGAN auto-convert ke token.
 * Biarkan user decide: convert token ATAU pakai untuk subscription.
 */

(function () {
  'use strict';

  if (window.Web2AppAuth) Web2AppAuth.initSupabase();

  const TOKEN_PRICE = 500;

  const state = {
    selectedAmount: 0,
    wallet: null,
    user: null,
  };

  // =============================================
  // INIT
  // =============================================
  async function init() {
    // Auth guard
    const session = await window.Web2AppAuth?.requireAuthGuard?.();
    if (!session) return;
    state.user = session.user;

    await loadWallet();
    setupEventListeners();
    updateConfirm();
  }

  // =============================================
  // LOAD WALLET
  // =============================================
  async function loadWallet() {
    const wallet = await Web2AppAPI.getMyWallet();
    state.wallet = wallet;

    if (!wallet) {
      console.warn('[deposit] wallet not loaded yet');
      return;
    }

    document.getElementById('depositCurrentBalance').textContent =
      Web2AppUI.formatIDR(wallet.balance_idr || 0);
    document.getElementById('depositCurrentTokens').textContent =
      wallet.token_balance || 0;
  }

  // =============================================
  // EVENT LISTENERS
  // =============================================
  function setupEventListeners() {
    // Preset buttons
    document.querySelectorAll('.deposit-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        const amount = Number(btn.dataset.amount);
        if (!amount) return;
        document.getElementById('depositCustomAmount').value = amount;
        state.selectedAmount = amount;
        // Highlight
        document.querySelectorAll('.deposit-option').forEach((b) =>
          b.classList.remove('bg-yellow-200', 'ring-4', 'ring-black')
        );
        btn.classList.add('bg-yellow-200', 'ring-4', 'ring-black');
        // Update token preview
        updateCustomPreview();
        updateConfirm();
      });
    });

    // Custom amount
    const customInput = document.getElementById('depositCustomAmount');
    if (customInput) {
      customInput.addEventListener('input', () => {
        state.selectedAmount = Number(customInput.value) || 0;
        // Un-highlight presets
        document.querySelectorAll('.deposit-option').forEach((b) =>
          b.classList.remove('bg-yellow-200', 'ring-4', 'ring-black')
        );
        updateCustomPreview();
        updateConfirm();
      });
    }

    // Auto-convert toggle
    const autoConvert = document.getElementById('depositAutoConvert');
    if (autoConvert) {
      autoConvert.addEventListener('change', updateConfirm);
    }

    // Submit
    document.getElementById('depositSubmitBtn').addEventListener('click', handleDeposit);

    // Token tab CTA
    document.getElementById('goToDepositBtn')?.addEventListener('click', () => {
      // Switch to deposit tab
      document.querySelectorAll('[data-tab]').forEach((t) =>
        t.classList.remove('tab-nb-active')
      );
      document.querySelector('[data-tab="deposit"]')?.classList.add('tab-nb-active');
      document.querySelectorAll('.tab-content').forEach((s) => s.classList.add('hidden'));
      document.getElementById('tab-deposit')?.classList.remove('hidden');
    });

    // Logout
    document.getElementById('logoutBtn')?.addEventListener('click', async (e) => {
      e.preventDefault();
      await Web2AppAuth.signOut();
    });
  }

  // =============================================
  // UPDATE CUSTOM PREVIEW
  // =============================================
  function updateCustomPreview() {
    const amount = state.selectedAmount;
    const tokens = Math.floor(amount / TOKEN_PRICE);
    const tokenSpan = document.getElementById('depositCustomTokens');
    if (tokenSpan) tokenSpan.textContent = tokens;

    // Show warning if not multiple of 500
    const warning = document.getElementById('depositCustomWarning');
    if (warning) {
      if (amount > 0 && amount % 500 !== 0) {
        warning.classList.remove('hidden');
      } else {
        warning.classList.add('hidden');
      }
    }
  }

  // =============================================
  // UPDATE CONFIRM
  // =============================================
  function updateConfirm() {
    const amount = state.selectedAmount;
    const autoConvert = document.getElementById('depositAutoConvert')?.checked || false;
    const btn = document.getElementById('depositSubmitBtn');
    const label = document.getElementById('depositConfirmLabel');
    const valueSpan = document.getElementById('depositConfirmValue');
    const amountSpan = document.getElementById('depositConfirmAmount');

    if (amountSpan) amountSpan.textContent = Web2AppUI.formatIDR(amount);

    if (!amount || amount < 500) {
      btn.disabled = true;
      btn.innerHTML =
        '<span data-icon="lock" class="h-5 w-5"></span> PILIH NOMINAL DULU';
      if (window.Web2AppFeather) Web2AppFeather.autoRender(btn);
      return;
    }

    if (amount % 500 !== 0) {
      btn.disabled = true;
      btn.innerHTML =
        '<span data-icon="alert-triangle" class="h-5 w-5"></span> HARUS KELIPATAN 500';
      if (window.Web2AppFeather) Web2AppFeather.autoRender(btn);
      return;
    }

    // Update confirm label
    if (label) {
      label.textContent = autoConvert ? 'Langsung Token' : 'Masuk Saldo';
    }
    if (valueSpan) {
      if (autoConvert) {
        const tokens = Math.floor(amount / TOKEN_PRICE);
        valueSpan.innerHTML = `+${tokens} <span class="text-base">token</span>`;
        valueSpan.className = 'text-2xl font-black mt-1 text-cyan-700';
      } else {
        valueSpan.textContent = `+${Web2AppUI.formatIDR(amount)}`;
        valueSpan.className = 'text-2xl font-black mt-1 text-green-700';
      }
    }

    // Enable button
    btn.disabled = false;
    const tokens = Math.floor(amount / TOKEN_PRICE);
    btn.innerHTML = autoConvert
      ? `<span data-icon="coin" class="h-5 w-5"></span> BAYAR ${Web2AppUI.formatIDR(amount)} → ${tokens} TOKEN`
      : `<span data-icon="dollar-sign" class="h-5 w-5"></span> DEPOSIT ${Web2AppUI.formatIDR(amount)} KE SALDO`;

    if (window.Web2AppFeather) Web2AppFeather.autoRender(btn);
  }

  // =============================================
  // HANDLE DEPOSIT
  // =============================================
  async function handleDeposit() {
    const amount = state.selectedAmount;
    if (!amount || amount % 500 !== 0) {
      Web2AppUI.showToast('Nominal tidak valid', 'error');
      return;
    }

    const autoConvert = document.getElementById('depositAutoConvert')?.checked || false;
    const btn = document.getElementById('depositSubmitBtn');
    Web2AppUI.setButtonLoading(btn, true);

    try {
      // Step 1: Create transaction
      const res = await Web2AppAPI.createTransaction({
        type: 'topup',
        amount_idr: amount,
        kind: autoConvert ? 'token' : 'saldo',
      });

      const orderId = res.data.order_id;

      // Step 2: Show QRIS modal
      showPaymentModal({
        orderId,
        amount,
        autoConvert,
      });
    } catch (err) {
      console.error('[deposit] failed:', err);
      Web2AppUI.showToast(err.message || 'Deposit gagal', 'error');
    } finally {
      Web2AppUI.setButtonLoading(btn, false);
    }
  }

  // =============================================
  // SHOW PAYMENT MODAL
  // =============================================
  function showPaymentModal({ orderId, amount, autoConvert }) {
    const tokensToGet = Math.floor(amount / TOKEN_PRICE);

    const content = `
      <div class="space-y-4">
        <div class="alert-nb alert-nb-warning">
          <span data-icon="clock" class="h-5 w-5 flex-shrink-0 mt-0.5"></span>
          <div>
            <p class="font-bold m-0">Selesaikan pembayaran sebelum 15 menit</p>
            <p class="text-xs font-bold text-gray-700 m-0">QRIS expired setelah itu</p>
          </div>
        </div>

        <div class="text-center">
          <p class="text-sm font-bold text-gray-700 mb-2">SCAN QRIS</p>
          <div class="bg-white border-3 border-black p-4 inline-block">
            <canvas id="qrCanvas" width="220" height="220"></canvas>
          </div>
          <p class="text-xs font-bold text-gray-700 mt-3 break-all">Order ID: <code>${orderId}</code></p>
        </div>

        <div class="border-t-3 border-black pt-4 space-y-2">
          <div class="flex justify-between font-bold">
            <span>Total Bayar</span>
            <span class="text-xl font-black">${Web2AppUI.formatIDR(amount)}</span>
          </div>
          <div class="flex justify-between font-bold">
            <span>${autoConvert ? 'Token masuk' : 'Saldo masuk'}</span>
            <span class="text-xl font-black ${autoConvert ? 'text-cyan-700' : 'text-green-700'}">
              ${autoConvert ? `+${tokensToGet} token` : `+${Web2AppUI.formatIDR(amount)}`}
            </span>
          </div>
          ${
            !autoConvert
              ? `<div class="flex justify-between font-bold text-sm text-gray-700">
                  <span>Token kalau di-convert nanti</span>
                  <span>${tokensToGet} token (1:500)</span>
                </div>`
              : ''
          }
        </div>

        ${
          autoConvert
            ? `<div class="bg-cyan-50 border-3 border-black p-3 text-sm font-bold">
                <span data-icon="info" class="h-5 w-5 inline-block align-middle"></span>
                Setelah bayar, token langsung masuk dan siap untuk build APK.
              </div>`
            : `<div class="bg-blue-50 border-3 border-black p-3 text-sm font-bold">
                <span data-icon="info" class="h-5 w-5 inline-block align-middle"></span>
                <strong>PENTING:</strong> Saldo masuk dulu, baru Anda pilih:
                <ul class="mt-1 ml-5 space-y-1 list-disc">
                  <li>Convert ke token (untuk build APK)</li>
                  <li>Berlangganan bulanan (Basic/Pro/Premium)</li>
                </ul>
              </div>`
        }
      </div>
    `;

    const footer = `
      <div class="flex gap-3">
        <button data-modal-close class="btn-nb flex-1 justify-center">Tutup</button>
        <button id="checkPaymentBtn" class="btn-nb btn-nb-success flex-1 justify-center">
          <span data-icon="check-circle" class="h-5 w-5"></span> Cek Status
        </button>
      </div>
    `;

    const modal = Web2AppUI.showModal({
      title: `Bayar ${Web2AppUI.formatIDR(amount)}`,
      content,
      footer,
      maxWidth: '480px',
    });

    // Render QR placeholder
    setTimeout(() => {
      const canvas = document.getElementById('qrCanvas');
      if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#FFE066';
        ctx.fillRect(0, 0, 220, 220);
        ctx.fillStyle = '#000';
        ctx.font = 'bold 14px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('QR Code Here', 110, 100);
        ctx.fillText('(scan via e-wallet)', 110, 120);
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 4;
        ctx.strokeRect(2, 2, 216, 216);
      }
      if (window.Web2AppFeather) Web2AppFeather.autoRender();
    }, 100);

    // Setup cek status
    document.getElementById('checkPaymentBtn').addEventListener('click', () =>
      checkStatus(orderId, autoConvert)
    );

    // Auto-poll setiap 5 detik
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
        handlePaymentSuccess(orderId, autoConvert);
      }
    }, 5000);

    // Stop polling when modal closed
    const observer = new MutationObserver(() => {
      if (!document.body.contains(document.querySelector('.modal-backdrop-nb'))) {
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

  async function checkStatus(orderId, autoConvert) {
    try {
      const res = await Web2AppAPI.getTransactionStatus(orderId);
      if (res.data.status === 'success') {
        handlePaymentSuccess(orderId, autoConvert);
      } else if (res.data.status === 'pending') {
        Web2AppUI.showToast('Belum terbayar. Selesaikan scan QR dulu!', 'warning');
      } else {
        Web2AppUI.showToast(`Status: ${res.data.status}`, 'error');
      }
    } catch (err) {
      Web2AppUI.showToast('Gagal cek status: ' + err.message, 'error');
    }
  }

  /**
   * Handle successful payment
   * - If autoConvert: token langsung masuk, redirect ke dashboard
   * - If saldo: kasih pilihan Convert ATAU Subscription
   */
  function handlePaymentSuccess(orderId, autoConvert) {
    // Close existing modal
    document.querySelector('.modal-backdrop-nb')?.remove();

    if (autoConvert) {
      Web2AppUI.showToast(
        `<span data-icon="check-circle" class="h-5 w-5"></span> ${Math.floor(state.selectedAmount / TOKEN_PRICE)} token sudah masuk!`,
        'success',
        4000
      );
      setTimeout(() => {
        window.location.href = 'dashboard.html';
      }, 2000);
      return;
    }

    // Saldo flow: kasih pilihan
    const tokensToGet = Math.floor(state.selectedAmount / TOKEN_PRICE);
    const content = `
      <div class="space-y-4">
        <div class="alert-nb alert-nb-success">
          <span data-icon="check-circle" class="h-5 w-5 flex-shrink-0"></span>
          <div>
            <p class="font-bold m-0">Saldo ${Web2AppUI.formatIDR(state.selectedAmount)} berhasil masuk!</p>
            <p class="text-xs font-bold text-gray-700 m-0">Order: <code>${orderId.substring(0, 8)}...</code></p>
          </div>
        </div>

        <p class="font-black text-base">Sekarang Anda mau ngapain?</p>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <a href="convert.html" class="card-nb-flat bg-cyan-200 border-3 border-black p-4 hover:bg-cyan-300 cursor-pointer text-center">
            <span data-icon="refresh-cw" class="h-8 w-8 inline-block"></span>
            <p class="font-black text-base mt-2">Convert ke Token</p>
            <p class="text-xs font-bold text-gray-700">${tokensToGet} token siap build</p>
          </a>

          <a href="pricing.html#subscription" data-modal-close class="card-nb-flat bg-yellow-200 border-3 border-black p-4 hover:bg-yellow-300 cursor-pointer text-center">
            <span data-icon="cube" class="h-8 w-8 inline-block"></span>
            <p class="font-black text-base mt-2">Berlangganan</p>
            <p class="text-xs font-bold text-gray-700">Pakai sebagian saldo</p>
          </a>
        </div>

        <div class="bg-gray-50 border-3 border-black p-3 text-xs font-bold text-gray-700">
          <span data-icon="info" class="h-5 w-5 inline-block align-middle"></span>
          Saldo Anda tersimpan aman di dompet. Bisa digunakan kapan saja.
        </div>
      </div>
    `;

    Web2AppUI.showModal({
      title: 'Deposit Berhasil!',
      content,
      footer: `
        <div class="flex gap-2">
          <a href="history.html" data-modal-close class="btn-nb flex-1 justify-center">
            <span data-icon="list-bullet" class="h-5 w-5"></span> Lihat History
          </a>
          <a href="dashboard.html" data-modal-close class="btn-nb btn-nb-primary flex-1 justify-center">
            <span data-icon="paint-brush" class="h-5 w-5"></span> Build APK
          </a>
        </div>
      `,
      maxWidth: '500px',
      onClose: () => {
        // Re-render icons di page
        if (window.Web2AppFeather) Web2AppFeather.autoRender();
        if (window.Web2AppIcons) Web2AppIcons.autoRender();
      },
    });

    // Re-render feather icons in modal
    setTimeout(() => {
      if (window.Web2AppFeather) Web2AppFeather.autoRender();
      if (window.Web2AppIcons) Web2AppIcons.autoRender();
    }, 100);

    // Reload wallet
    loadWallet();
  }

  // =============================================
  // BOOT
  // =============================================
  document.addEventListener('DOMContentLoaded', init);
})();
