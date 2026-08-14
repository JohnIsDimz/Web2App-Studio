-- =============================================
-- 03_webhook_audit.sql
-- Tabel audit untuk webhook Pakasir + index performa
-- =============================================
-- Jalankan file ini SETELAH 01_schema.sql & 02_builds.sql
-- di Supabase SQL Editor.

-- ===============
-- 1. Tabel webhook_audit
-- ===============
-- Setiap webhook yang masuk dari Pakasir dicatat di sini.
-- Berguna untuk:
--   - Debugging: "kenapa saldo user gak masuk?"
--   - Security: "ada webhook aneh gak?"
--   - Compliance: trail untuk audit pembayaran
CREATE TABLE IF NOT EXISTS public.webhook_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Request info
  ip_address INET,
  user_agent TEXT,
  
  -- Payload info (ringkas, JANGAN simpan full payload karena bisa ada PII)
  payload_summary JSONB,
  
  -- Decision & reason
  decision TEXT NOT NULL,  -- 'applied' | 'ignored' | 'rejected' | 'acknowledged' | 'error' | 'marked_expired' | 'marked_cancelled' | 'marked_failed'
  reason TEXT,             -- 'amount_mismatch' | 'invalid_signature' | 'race_condition_lost' | dll
  
  -- Relasi
  transaction_id UUID REFERENCES public.transactions(id) ON DELETE SET NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  
  -- Performance
  duration_ms INT,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.webhook_audit IS
  'Audit trail untuk semua webhook Pakasir. Setiap request dicatat untuk debugging & security.';

-- ===============
-- 2. Index untuk query umum
-- ===============

-- Cari audit by transaction_id (untuk debug "kenapa tx X gak masuk saldonya?")
CREATE INDEX IF NOT EXISTS idx_webhook_audit_transaction
  ON public.webhook_audit(transaction_id, created_at DESC);

-- Cari audit by user_id (untuk liat history webhook user)
CREATE INDEX IF NOT EXISTS idx_webhook_audit_user
  ON public.webhook_audit(user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

-- Cari decision tertentu (misal: semua "amount_mismatch" minggu ini)
CREATE INDEX IF NOT EXISTS idx_webhook_audit_decision
  ON public.webhook_audit(decision, created_at DESC);

-- Cari error untuk alerting
CREATE INDEX IF NOT EXISTS idx_webhook_audit_errors
  ON public.webhook_audit(created_at DESC)
  WHERE decision IN ('rejected', 'error');

-- ===============
-- 3. Tabel pending_transaction_expiry
-- ===============
-- Transaksi yang pending terlalu lama di sini.
-- Cron job scan table ini dan tandai expired.
-- (Lebih efisien daripada query transactions WHERE status='pending' AND created_at < ...)

-- Pakai kolom existing di transactions aja, gak perlu tabel baru.
-- Tinggal tambah index:
CREATE INDEX IF NOT EXISTS idx_transactions_pending_expire
  ON public.transactions(created_at)
  WHERE status = 'pending';

-- ===============
-- 4. Tabel reconciliation_log
-- ===============
-- Log untuk self-healing job yang detect transaksi success
-- tapi wallet gak ke-update (webhook missed).
CREATE TABLE IF NOT EXISTS public.reconciliation_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Apa yang ditemukan
  issue_type TEXT NOT NULL,  -- 'success_no_wallet_effect' | 'wallet_mismatch' | 'pending_too_old'
  transaction_id UUID REFERENCES public.transactions(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  wallet_id UUID REFERENCES public.wallets(id) ON DELETE SET NULL,
  
  -- Detail
  detected_balance_idr NUMERIC,
  detected_token_balance NUMERIC,
  expected_balance_idr NUMERIC,
  expected_token_balance NUMERIC,
  
  -- Action yang diambil
  action_taken TEXT,        -- 'auto_fixed' | 'manual_required' | 'no_action'
  notes TEXT,
  
  -- Metadata
  metadata JSONB,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.reconciliation_log IS
  'Log dari reconciliation job yang detect mismatch antara transactions & wallets.';

CREATE INDEX IF NOT EXISTS idx_reconciliation_log_unfixed
  ON public.reconciliation_log(created_at DESC)
  WHERE action_taken = 'manual_required';

CREATE INDEX IF NOT EXISTS idx_reconciliation_log_user
  ON public.reconciliation_log(user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

-- ===============
-- 5. RLS Policy untuk audit tables
-- ===============
-- Audit tables cuma boleh dibaca sama admin / owner.
-- Write hanya dari service_role (server kita).

ALTER TABLE public.webhook_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconciliation_log ENABLE ROW LEVEL SECURITY;

-- Policy: user hanya bisa liat audit miliknya sendiri
DROP POLICY IF EXISTS "Users can view own webhook audit" ON public.webhook_audit;
CREATE POLICY "Users can view own webhook audit"
  ON public.webhook_audit FOR SELECT
  USING (auth.uid() = user_id);

-- Policy: user hanya bisa liat reconciliation miliknya sendiri
DROP POLICY IF EXISTS "Users can view own reconciliation log" ON public.reconciliation_log;
CREATE POLICY "Users can view own reconciliation log"
  ON public.reconciliation_log FOR SELECT
  USING (auth.uid() = user_id);

-- Service role bypass RLS by default, jadi INSERT dari server aman.

-- ===============
-- 6. Cleanup job: hapus audit log > 90 hari
-- ===============
-- (Optional, bisa di-schedule via cron)
-- DELETE FROM public.webhook_audit WHERE created_at < now() - interval '90 days';
-- DELETE FROM public.reconciliation_log WHERE created_at < now() - interval '90 days';
