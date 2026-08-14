/**
 * Web2App Studio - Beli Token Pakai Saldo Page
 * ============================================
 *
 * SISTEM BARU (FINAL):
 *   - Token adalah PRODUK, bukan hasil convert
 *   - User top up saldo dulu (pricing.html#deposit)
 *   - User beli token pakai saldo (HALAMAN INI)
 *   - Rate: 1 token = Rp 500
 *   - Instant: saldo langsung dipotong, token langsung masuk
 *
 * Flow:
 *   1. User pilih nominal (5K/10K/25K/50K atau custom, min Rp 500)
 *   2. Klik "BELI TOKEN"
 *   3. POST /api/transactions/create { type: 'token_purchase', amount_idr: X }
 *   4. Backend atomic: potong saldo + tambah token
 *   5. Response: saldo_before/after, tokens_before/after
 *   6. Tampil modal sukses + CTA "Build APK"
 */

(function () {
  'use strict';

  if (window.Web2AppAuth) Web2AppAuth.initSupabase();

  const TOKEN_PRICE = 500;
  const state = {
    selectedAmount: 0,
    wallet: null,
  };

  async function init() {
    const session = await Web2AppAuth.requireAuthGuard();
    if (!session) return;
    state.user = session.user;
    await loadWallet();
    setupEventListeners();
    updatePreview();
  }

  async function loadWallet() {
    const wallet = await Web2AppAPI.getMyWallet();
    state.wallet = wallet;
    if (!wallet) {
      Web2AppUI.showToast('Gagal memuat wallet', 'error');
      return;
    }
    document.getElementById('convertBalance').textContent = Web2AppUI.formatIDR(wallet.balance_idr || 0);
    document.getElementById('convertTokens').textContent = wallet.token_balance || 0;
  }

  function setupEventListeners() {
    // Quick amount buttons
    document.querySelectorAll('.convert-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        const amount = Number(btn.dataset.amount);
        state.selectedAmount = amount;
        document.getElementById('convertAmount').value = amount;
        document.querySelectorAll('.convert-option').forEach((b) => b.classList.remove('bg-yellow-200'));
        btn.classList.add('bg-yellow-200');
        updatePreview();
      });
    });

    // Custom input
    const amountInput = document.getElementById('convertAmount');
    amountInput.addEventListener('input', () => {
      state.selectedAmount = Number(amountInput.value) || 0;
      document.querySelectorAll('.convert-option').forEach((b) => b.classList.remove('bg-yellow-200'));
      updatePreview();
    });

    // Submit
    document.getElementById('convertSubmitBtn').addEventListener('click', handleBuy);

    // Logout
    document.getElementById('logoutBtn')?.addEventListener('click', async (e) => {
      e.preventDefault();
      await Web2AppAuth.signOut();
    });
  }

  function updatePreview() {
    const amount = state.selectedAmount;
    const tokens = Math.floor(amount / TOKEN_PRICE);
    const valid = amount > 0 && amount % 500 === 0 && amount <= (state.wallet?.balance_idr || 0);

    document.getElementById('convertPreviewAmount').textContent = `-${Web2AppUI.formatIDR(amount)}`;
    document.getElementById('convertPreviewTokens').textContent = tokens;

    const btn = document.getElementById('convertSubmitBtn');
    if (!valid) {
      btn.disabled = true;
      if (amount === 0) {
        btn.innerHTML = '<span data-icon="lock" class="h-5 w-5"></span> MASUKKAN NOMINAL';
      } else if (amount % 500 !== 0) {
        btn.innerHTML = '<span data-icon="alert-triangle" class="h-5 w-5"></span> HARUS KELIPATAN 500';
      } else {
        btn.innerHTML = '<span data-icon="alert-triangle" class="h-5 w-5"></span> SALDO TIDAK CUKUP';
      }
    } else {
      btn.disabled = false;
      btn.innerHTML = `<span data-icon="check-circle" class="h-5 w-5"></span> BELI ${tokens} TOKEN (${Web2AppUI.formatIDR(amount)})`;
    }

    if (window.Web2AppFeather) Web2AppFeather.autoRender(btn);
  }

  async function handleBuy() {
    const amount = state.selectedAmount;
    if (!amount || amount % 500 !== 0) {
      Web2AppUI.showToast('Nominal tidak valid', 'error');
      return;
    }

    const btn = document.getElementById('convertSubmitBtn');
    Web2AppUI.setButtonLoading(btn, true);

    try {
      // Panggil endpoint BARU: type='token_purchase'
      const res = await Web2AppAPI.buyTokensWithSaldo({ amount });
      const d = res.data;

      // Show success modal
      Web2AppUI.showModal({
        title: 'Pembelian Token Berhasil!',
        content: `
          <div class="space-y-3">
            <div class="alert-nb alert-nb-success">
              <span data-icon="check-circle" class="h-5 w-5 flex-shrink-0"></span>
              <div>
                <p class="font-bold m-0">${d.tokensAdded} token sudah masuk!</p>
                <p class="text-xs font-bold m-0">${Web2AppUI.formatIDR(amount)} saldo terpotong</p>
              </div>
            </div>

            <div class="grid grid-cols-2 gap-2 text-sm">
              <div class="bg-red-100 p-2">
                <p class="text-xs font-black text-gray-700">Saldo</p>
                <p class="text-xs">${Web2AppUI.formatIDR(d.balanceBefore)}</p>
                <p class="text-lg font-black">→ ${Web2AppUI.formatIDR(d.balanceAfter)}</p>
              </div>
              <div class="bg-green-100 p-2">
                <p class="text-xs font-black text-gray-700">Token</p>
                <p class="text-xs">${d.tokensBefore}</p>
                <p class="text-lg font-black">→ ${d.tokensAfter}</p>
              </div>
            </div>
          </div>
        `,
        footer: `
          <div class="flex gap-2">
            <button data-modal-close class="btn-nb flex-1 justify-center">Tutup</button>
            <a href="dashboard.html" data-modal-close class="btn-nb btn-nb-primary flex-1 justify-center">
              <span data-icon="paint-brush" class="h-5 w-5"></span> Build APK
            </a>
          </div>
        `,
      });

      // Reload wallet
      await loadWallet();
      if (window.Web2AppFeather) Web2AppFeather.autoRender();
    } catch (err) {
      console.error('[buy-token] failed:', err);

      // Kalau saldo kurang, kasih CTA topup
      if (err.code === 'INSUFFICIENT_BALANCE') {
        Web2AppUI.showModal({
          title: 'Saldo Tidak Cukup',
          content: `
            <p>Saldo Anda tidak cukup untuk beli ${amount / TOKEN_PRICE} token.</p>
            <p class="font-bold mt-3">Top up saldo dulu?</p>
          `,
          footer: `
            <div class="flex gap-2">
              <button data-modal-close class="btn-nb flex-1 justify-center">Nanti</button>
              <a href="pricing.html#deposit" data-modal-close class="btn-nb btn-nb-primary flex-1 justify-center">
                <span data-icon="dollar-sign" class="h-5 w-5"></span> Top Up
              </a>
            </div>
          `,
        });
        return;
      }

      Web2AppUI.showToast(err.message || 'Beli token gagal', 'error');
    } finally {
      Web2AppUI.setButtonLoading(btn, false);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
