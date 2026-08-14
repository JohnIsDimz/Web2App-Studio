/**
 * Web2App Studio - History Page Logic
 * ============================================
 * Real-time wallet & transaction history.
 * - Load wallet summary
 * - Load transaction history with filter
 * - Auto-refresh every 30 seconds
 * - Real-time Supabase subscription for live updates
 */

(function () {
  'use strict';

  if (window.Web2AppAuth) Web2AppAuth.initSupabase();

  const state = {
    wallet: null,
    currentFilter: '',
  };

  const TYPE_META = {
    topup: {
      label: 'Top Up Saldo',
      icon: 'plus',
      color: 'green',
      bgClass: 'bg-green-50',
    },
    build: {
      label: 'Build APK',
      icon: 'package',
      color: 'blue',
      bgClass: 'bg-blue-50',
    },
    subscription: {
      label: 'Langganan',
      icon: 'package',
      color: 'purple',
      bgClass: 'bg-purple-50',
    },
    refund: {
      label: 'Refund',
      icon: 'rotate-ccw',
      color: 'orange',
      bgClass: 'bg-orange-50',
    },
  };

  async function init() {
    const session = await Web2AppAuth.requireAuthGuard();
    if (!session) return;
    state.user = session.user;

    await loadWallet();
    await loadHistory();

    setupEventListeners();
    setupRealtimeSubscription();

    // Auto-refresh every 30s
    setInterval(async () => {
      await loadWallet();
      await loadHistory();
    }, 30000);
  }

  async function loadWallet() {
    const wallet = await Web2AppAPI.getMyWallet();
    state.wallet = wallet;
    if (!wallet) return;

    document.getElementById('histBalance').textContent = Web2AppUI.formatIDR(wallet.balance_idr || 0);
    document.getElementById('histTokens').textContent = wallet.token_balance || 0;

    const tierLabels = { none: 'FREE TRIAL', basic: 'BASIC', pro: 'PRO', premium: 'PREMIUM' };
    document.getElementById('histTier').textContent = tierLabels[wallet.subscription_tier] || 'FREE';
  }

  async function loadHistory() {
    try {
      const res = await Web2AppAPI.getWalletHistory({ limit: 50, type: state.currentFilter || null });
      const { transactions = [], summary = {} } = res.data || {};

      // Update summary
      document.getElementById('statDeposit').textContent = Web2AppUI.formatIDR(summary.total_deposit_idr || 0);
      document.getElementById('statConvert').textContent = Web2AppUI.formatIDR(summary.total_convert_idr || 0);
      document.getElementById('statTokenUsed').textContent = summary.total_token_used || 0;
      document.getElementById('statSubscription').textContent = Web2AppUI.formatIDR(summary.total_subscription_idr || 0);

      // Render transactions
      const list = document.getElementById('historyList');
      if (transactions.length === 0) {
        list.innerHTML = `
          <div class="text-center py-12">
            <span data-icon="inbox" class="h-16 w-16 text-gray-300 inline-block"></span>
            <p class="font-bold text-sm text-gray-700 mt-3">Belum ada transaksi</p>
            <p class="text-xs font-bold text-gray-500">Mulai deposit atau build APK!</p>
          </div>
        `;
        if (window.Web2AppFeather) Web2AppFeather.autoRender();
        return;
      }

      list.innerHTML = transactions.map(renderTransaction).join('');
      if (window.Web2AppFeather) Web2AppFeather.autoRender();
    } catch (err) {
      console.error('[history] load failed:', err);
    }
  }

  function renderTransaction(tx) {
    const meta = TYPE_META[tx.type] || { label: tx.type, icon: 'circle', bgClass: 'bg-gray-50' };
    const isPositive = tx.type === 'topup' || tx.metadata?.kind === 'saldo_to_token';
    const isConvert = tx.metadata?.kind === 'saldo_to_token';
    const tokenDelta = Number(tx.token_amount || 0);
    const idrDelta = Number(tx.amount_idr || 0);

    let mainText = '';
    let subText = '';

    if (isConvert) {
      // Convert: saldo → token
      mainText = `<span class="text-red-600">-${Web2AppUI.formatIDR(tx.metadata.amount_idr || 0)}</span> → <span class="text-green-600">+${tokenDelta} token</span>`;
      subText = 'Convert saldo ke token';
    } else if (tx.type === 'topup') {
      mainText = `<span class="text-green-600">+${Web2AppUI.formatIDR(idrDelta)}</span> saldo`;
      subText = tokenDelta > 0 ? `+${tokenDelta} token (langsung convert)` : 'Deposit saldo';
    } else if (tx.type === 'build') {
      mainText = `<span class="text-red-600">-${Math.abs(tokenDelta)}</span> token`;
      subText = tx.description || 'Build APK';
    } else if (tx.type === 'subscription') {
      mainText = `<span class="text-green-600">+${Web2AppUI.formatIDR(idrDelta)}</span>`;
      subText = tx.description || 'Langganan bulanan';
    } else if (tx.type === 'refund') {
      mainText = `<span class="text-green-600">+${Math.abs(tokenDelta)}</span> token`;
      subText = tx.description || 'Refund token';
    }

    const statusColor = {
      success: 'bg-green-400',
      pending: 'bg-yellow-300',
      failed: 'bg-red-400',
      expired: 'bg-gray-300',
      cancelled: 'bg-gray-300',
    }[tx.status] || 'bg-gray-300';

    return `
      <div class="border-3 border-black p-3 ${meta.bgClass} hover:shadow-nb transition-all">
        <div class="flex items-start gap-3">
          <div class="w-10 h-10 ${statusColor} border-2 border-black flex items-center justify-center flex-shrink-0">
            <span data-icon="${meta.icon}" class="h-5 w-5"></span>
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between gap-2">
              <p class="font-black text-sm m-0">${meta.label}</p>
              <p class="text-xs font-bold text-gray-600 m-0">${Web2AppUI.formatDate(tx.created_at)}</p>
            </div>
            <p class="text-sm font-bold m-0 mt-1">${mainText}</p>
            <p class="text-xs font-bold text-gray-700 m-0 mt-1">${subText}</p>
            ${
              tx.balance_after_idr !== null
                ? `<p class="text-xs font-bold text-gray-500 m-0 mt-1">
                     Saldo: ${Web2AppUI.formatIDR(tx.balance_after_idr)} • Token: ${tx.token_after}
                   </p>`
                : ''
            }
          </div>
        </div>
      </div>
    `;
  }

  function setupEventListeners() {
    // Filter buttons
    document.querySelectorAll('.hist-filter').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.currentFilter = btn.dataset.type;
        document.querySelectorAll('.hist-filter').forEach((b) => b.classList.remove('tab-nb-active'));
        btn.classList.add('tab-nb-active');
        loadHistory();
      });
    });

    // Refresh button
    document.getElementById('refreshHistory').addEventListener('click', async () => {
      await loadWallet();
      await loadHistory();
      Web2AppUI.showToast('Refreshed!', 'success', 1500);
    });

    // Logout
    document.getElementById('logoutBtn')?.addEventListener('click', async (e) => {
      e.preventDefault();
      await Web2AppAuth.signOut();
    });
  }

  /**
   * Real-time subscription: auto-refresh saat ada transaksi baru
   */
  function setupRealtimeSubscription() {
    if (!window.supabase) return;

    window.supabase
      .channel('transactions-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'transactions',
          filter: `user_id=eq.${state.user.id}`,
        },
        (payload) => {
          console.log('[realtime] transaction update:', payload.eventType);
          // Reload wallet & history
          loadWallet();
          loadHistory();
        }
      )
      .subscribe();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
