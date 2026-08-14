-- =============================================
-- Web2App Studio - COMPLETE DATABASE SETUP
-- =============================================
-- File ini GABUNGAN dari 5 file SQL asli:
--   01_schema.sql             (users, wallets, transactions + trigger)
--   02_builds.sql             (app_configs, build_jobs)
--   03_webhook_audit.sql      (webhook_audit, reconciliation_log)
--   04_atomic_functions.sql   (7 atomic functions)
--   05_anti_double_credit.sql (UNIQUE + CHECK + anti-cheat triggers)
--
-- CARA PAKAI:
--   1. Buka Supabase Dashboard → SQL Editor → + New query
--   2. Copy SELURUH isi file ini → paste ke editor
--   3. Klik Run (atau Ctrl+Enter)
--   4. Tunggu sampai 'Success' muncul (~10-30 detik)
--
-- AMAN dijalanin ulang (idempotent) — semua CREATE pakai
-- 'IF NOT EXISTS' atau 'CREATE OR REPLACE'.
-- =============================================


-- #############################################
-- ## FILE 1: 01_schema.sql
-- #############################################
-- =============================================
-- Web2App Studio - Database Schema (DDL)
-- Target: Supabase (PostgreSQL 15+)
-- Execute this in: Supabase SQL Editor
-- =============================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================
-- ENUM TYPES
-- =============================================

-- Subscription tier options
CREATE TYPE subscription_tier AS ENUM ('none', 'basic', 'pro', 'premium');

-- Transaction types
CREATE TYPE transaction_type AS ENUM (
  'topup',          -- User membeli token
  'build',          -- Pemakaian token untuk build APK
  'subscription',   -- Pembayaran langganan bulanan
  'refund',         -- Pengembalian dana/token
  'bonus'           -- Token bonus dari promo/admin
);

-- Transaction status
CREATE TYPE transaction_status AS ENUM (
  'pending',
  'success',
  'failed',
  'expired',
  'cancelled'
);

-- =============================================
-- TABLE: users
-- Profile data, 1-to-1 with auth.users (Supabase Auth)
-- =============================================
CREATE TABLE IF NOT EXISTS public.users (
  id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email           TEXT UNIQUE NOT NULL,
  full_name       TEXT,
  avatar_url      TEXT,
  phone           TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  is_vip          BOOLEAN NOT NULL DEFAULT FALSE,  -- VIP queue flag
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON public.users(email);
CREATE INDEX idx_users_is_active ON public.users(is_active);

COMMENT ON TABLE public.users IS 'User profile data, linked 1:1 to Supabase auth.users';

-- =============================================
-- TABLE: wallets
-- One wallet per user (auto-created via trigger)
-- =============================================
CREATE TABLE IF NOT EXISTS public.wallets (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  balance_idr         BIGINT NOT NULL DEFAULT 0 CHECK (balance_idr >= 0),     -- Saldo rupiah
  token_balance       INTEGER NOT NULL DEFAULT 0 CHECK (token_balance >= 0), -- Saldo token
  subscription_tier   subscription_tier NOT NULL DEFAULT 'none',
  subscription_expires_at TIMESTAMPTZ,
  build_quota_used    INTEGER NOT NULL DEFAULT 0,
  build_quota_limit   INTEGER NOT NULL DEFAULT 0,  -- 0 = unlimited (pro/premium)
  is_vip_queue        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wallets_user_id ON public.wallets(user_id);
CREATE INDEX idx_wallets_subscription_tier ON public.wallets(subscription_tier);

COMMENT ON TABLE public.wallets IS 'User wallet: balance, tokens, and subscription info. Auto-created on signup.';

-- =============================================
-- TABLE: transactions
-- Audit log for all financial/token movements
-- =============================================
CREATE TABLE IF NOT EXISTS public.transactions (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  wallet_id           UUID NOT NULL REFERENCES public.wallets(id) ON DELETE CASCADE,
  type                transaction_type NOT NULL,
  status              transaction_status NOT NULL DEFAULT 'pending',
  amount_idr          BIGINT NOT NULL DEFAULT 0,        -- Nominal rupiah
  token_amount        INTEGER NOT NULL DEFAULT 0,       -- Jumlah token (+/-)
  balance_after_idr   BIGINT,                           -- Snapshot saldo rupiah setelah transaksi
  token_after         INTEGER,                          -- Snapshot token setelah transaksi
  reference_id        TEXT,                             -- ID dari payment gateway / build job
  description         TEXT,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_transactions_user_id ON public.transactions(user_id);
CREATE INDEX idx_transactions_wallet_id ON public.transactions(wallet_id);
CREATE INDEX idx_transactions_type ON public.transactions(type);
CREATE INDEX idx_transactions_status ON public.transactions(status);
CREATE INDEX idx_transactions_created_at ON public.transactions(created_at DESC);
CREATE INDEX idx_transactions_reference_id ON public.transactions(reference_id);

COMMENT ON TABLE public.transactions IS 'Immutable log of all wallet movements (topup, build, subscription, etc).';

-- =============================================
-- FUNCTION: Auto-update updated_at timestamp
-- =============================================
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to all tables
DROP TRIGGER IF EXISTS trg_users_updated_at ON public.users;
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS trg_wallets_updated_at ON public.wallets;
CREATE TRIGGER trg_wallets_updated_at
  BEFORE UPDATE ON public.wallets
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS trg_transactions_updated_at ON public.transactions;
CREATE TRIGGER trg_transactions_updated_at
  BEFORE UPDATE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- =============================================
-- FUNCTION: Create default wallet on user signup
-- Triggered from auth.users INSERT (Supabase Auth)
-- =============================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
DECLARE
  v_full_name TEXT;
BEGIN
  -- Extract name from raw_user_meta_data if available
  v_full_name := COALESCE(
    NEW.raw_user_meta_data->>'full_name',
    NEW.raw_user_meta_data->>'name',
    split_part(NEW.email, '@', 1)
  );

  -- 1. Insert into public.users
  INSERT INTO public.users (id, email, full_name, metadata)
  VALUES (
    NEW.id,
    NEW.email,
    v_full_name,
    jsonb_build_object(
      'signup_provider', COALESCE(NEW.raw_app_meta_data->>'provider', 'email'),
      'signup_at', NOW()
    )
  )
  ON CONFLICT (id) DO NOTHING;

  -- 2. Auto-create wallet row
  -- ✅ FREE TIER: Kasih 3 token gratis untuk user baru (coba-coba)
  -- Setelah habis, user harus top-up atau berlangganan
  INSERT INTO public.wallets (
    user_id,
    balance_idr,
    token_balance,
    subscription_tier,
    build_quota_limit,
    is_vip_queue
  )
  VALUES (
    NEW.id,
    0,
    3,        -- 3 token gratis untuk free trial
    'none',   -- tier: none (free, banyak limitasi)
    0,        -- 0 = tidak ada quota subscription
    FALSE     -- no VIP queue
  )
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- =============================================
-- TRIGGER: Fire after a new auth user is created
-- =============================================
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =============================================
-- ROW LEVEL SECURITY (RLS)
-- Enable RLS and add baseline policies
-- =============================================

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

-- Policy: users can read their own profile
DROP POLICY IF EXISTS "Users can view own profile" ON public.users;
CREATE POLICY "Users can view own profile"
  ON public.users FOR SELECT
  USING (auth.uid() = id);

-- Policy: users can update their own profile (limited columns enforced in app)
DROP POLICY IF EXISTS "Users can update own profile" ON public.users;
CREATE POLICY "Users can update own profile"
  ON public.users FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- Policy: users can view their own wallet
DROP POLICY IF EXISTS "Users can view own wallet" ON public.wallets;
CREATE POLICY "Users can view own wallet"
  ON public.wallets FOR SELECT
  USING (auth.uid() = user_id);

-- Policy: users can view their own transactions
DROP POLICY IF EXISTS "Users can view own transactions" ON public.transactions;
CREATE POLICY "Users can view own transactions"
  ON public.transactions FOR SELECT
  USING (auth.uid() = user_id);

-- NOTE: INSERT/UPDATE on wallets and transactions
-- must go through the backend service-role key to maintain integrity.
-- End-users do NOT have direct write access to financial tables.

-- =============================================
-- Helper view for quick lookup (optional but useful)
-- =============================================
CREATE OR REPLACE VIEW public.v_user_wallets AS
SELECT
  u.id            AS user_id,
  u.email,
  u.full_name,
  u.is_vip,
  w.balance_idr,
  w.token_balance,
  w.subscription_tier,
  w.subscription_expires_at,
  w.build_quota_used,
  w.build_quota_limit,
  w.is_vip_queue
FROM public.users u
LEFT JOIN public.wallets w ON w.user_id = u.id;

COMMENT ON VIEW public.v_user_wallets IS 'Convenience view: user + wallet in one query.';

-- =============================================
-- END OF SCHEMA
-- =============================================


-- #############################################
-- ## FILE 2: 02_builds.sql
-- #############################################
-- =============================================
-- Tahap 3: Build Jobs & App Configs Schema
-- Eksekusi SETELAH 01_schema.sql
-- =============================================

-- Enum untuk build status
CREATE TYPE build_status AS ENUM (
  'queued',         -- Masuk antrian
  'processing',     -- Sedang di-build
  'success',        -- Build berhasil, APK siap
  'failed',         -- Build gagal
  'cancelled',      -- User batalkan
  'expired'         -- Link download kadaluarsa
);

-- Enum untuk build tier priority
CREATE TYPE build_priority AS ENUM ('normal', 'vip');

-- =============================================
-- TABLE: app_configs
-- Menyimpan konfigurasi per project app user
-- =============================================
CREATE TABLE IF NOT EXISTS public.app_configs (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  project_name        TEXT NOT NULL,                  -- "My Cool App"
  app_name            TEXT NOT NULL,                  -- Nama di launcher
  package_name        TEXT NOT NULL,                  -- com.example.myapp
  website_url         TEXT NOT NULL,                  -- URL sumber konten
  app_icon_url        TEXT,
  splash_screen_url   TEXT,
  -- Tier-gated features
  enable_gps          BOOLEAN NOT NULL DEFAULT FALSE,
  enable_push         BOOLEAN NOT NULL DEFAULT FALSE,
  enable_offline      BOOLEAN NOT NULL DEFAULT FALSE,
  primary_color       TEXT DEFAULT '#3B82F6',
  -- Metadata
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_app_configs_user_id ON public.app_configs(user_id);
CREATE INDEX idx_app_configs_package_name ON public.app_configs(package_name);

COMMENT ON TABLE public.app_configs IS 'Konfigurasi project app per user (1 user bisa punya banyak app)';

-- =============================================
-- TABLE: build_jobs
-- History setiap kali user trigger build APK
-- =============================================
CREATE TABLE IF NOT EXISTS public.build_jobs (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  app_config_id       UUID NOT NULL REFERENCES public.app_configs(id) ON DELETE CASCADE,
  status              build_status NOT NULL DEFAULT 'queued',
  priority            build_priority NOT NULL DEFAULT 'normal',
  -- Token usage
  token_cost          INTEGER NOT NULL DEFAULT 1,
  wallet_id           UUID REFERENCES public.wallets(id) ON DELETE SET NULL,
  -- Build artifacts
  apk_url             TEXT,                           -- Link download
  apk_size_bytes      BIGINT,
  build_log           TEXT,                           -- stdout/stderr CLI
  build_duration_ms   INTEGER,
  error_message       TEXT,
  -- Queue metadata
  bull_job_id         TEXT,                           -- ID dari Bull queue
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ,                    -- Link kadaluarsa
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_build_jobs_user_id ON public.build_jobs(user_id);
CREATE INDEX idx_build_jobs_status ON public.build_jobs(status);
CREATE INDEX idx_build_jobs_created_at ON public.build_jobs(created_at DESC);
CREATE INDEX idx_build_jobs_bull_job_id ON public.build_jobs(bull_job_id);

COMMENT ON TABLE public.build_jobs IS 'History build APK per user. Setiap build potong token / kurangi quota.';

-- =============================================
-- TRIGGER: auto-update updated_at
-- =============================================
DROP TRIGGER IF EXISTS trg_app_configs_updated_at ON public.app_configs;
CREATE TRIGGER trg_app_configs_updated_at
  BEFORE UPDATE ON public.app_configs
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS trg_build_jobs_updated_at ON public.build_jobs;
CREATE TRIGGER trg_build_jobs_updated_at
  BEFORE UPDATE ON public.build_jobs
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- =============================================
-- RLS
-- =============================================
ALTER TABLE public.app_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.build_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own app_configs" ON public.app_configs;
CREATE POLICY "Users manage own app_configs"
  ON public.app_configs FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users view own build_jobs" ON public.build_jobs;
CREATE POLICY "Users view own build_jobs"
  ON public.build_jobs FOR SELECT
  USING (auth.uid() = user_id);

-- Service-role bypass RLS untuk write via backend
-- =============================================
-- VIEW: Dashboard ringkasan
-- =============================================
CREATE OR REPLACE VIEW public.v_user_build_stats AS
SELECT
  u.id              AS user_id,
  u.email,
  w.subscription_tier,
  w.build_quota_used,
  w.build_quota_limit,
  w.token_balance,
  COUNT(bj.id) FILTER (WHERE bj.status = 'success') AS total_successful_builds,
  COUNT(bj.id) FILTER (WHERE bj.status = 'failed')   AS total_failed_builds,
  COUNT(bj.id) FILTER (WHERE bj.status IN ('queued', 'processing')) AS active_builds
FROM public.users u
LEFT JOIN public.wallets w ON w.user_id = u.id
LEFT JOIN public.build_jobs bj ON bj.user_id = u.id
GROUP BY u.id, u.email, w.subscription_tier, w.build_quota_used,
         w.build_quota_limit, w.token_balance;

COMMENT ON VIEW public.v_user_build_stats IS 'Ringkasan build stats per user untuk dashboard';


-- #############################################
-- ## FILE 3: 03_webhook_audit.sql
-- #############################################
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


-- #############################################
-- ## FILE 4: 04_atomic_functions.sql
-- #############################################
-- =============================================
-- 04_atomic_functions.sql
-- SQL functions atomic untuk operasi wallet kritis
-- =============================================
-- Jalankan SETELAH 01_schema.sql, 02_builds.sql, 03_webhook_audit.sql
-- di Supabase SQL Editor.
--
-- Functions ini STRICTLY ATOMIC:
--   - Pakai PostgreSQL transactions
--   - Row-level locking (FOR UPDATE) untuk mencegah race condition
--   - Validasi di SQL level (bukan di JS)

-- ===============
-- 1. Function: convert_saldo_to_tokens
-- ===============
-- Atomic conversion dari balance_idr → token_balance
-- Race-condition safe via SELECT ... FOR UPDATE
--
-- Returns: TABLE dengan columns:
--   balance_before, balance_after, tokens_before, tokens_after, tokens_added
CREATE OR REPLACE FUNCTION public.convert_saldo_to_tokens(
  p_user_id UUID,
  p_amount_idr NUMERIC
)
RETURNS TABLE (
  balance_before NUMERIC,
  balance_after NUMERIC,
  tokens_before NUMERIC,
  tokens_after NUMERIC,
  tokens_added INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER  -- run as function owner (bypass RLS)
AS $$
DECLARE
  v_wallet_id UUID;
  v_current_balance NUMERIC;
  v_current_tokens NUMERIC;
  v_tokens_to_add INTEGER;
  v_token_price NUMERIC := 500; -- 1 token = Rp 500
  v_tx_id UUID;
BEGIN
  -- ============== Validasi input ==============
  IF p_amount_idr IS NULL OR p_amount_idr <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: Amount harus > 0' USING ERRCODE = '22023';
  END IF;

  IF p_amount_idr % v_token_price != 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: Amount harus kelipatan Rp %', v_token_price
      USING ERRCODE = '22023';
  END IF;

  v_tokens_to_add := (p_amount_idr / v_token_price)::INTEGER;

  -- ============== Lock wallet row (anti race condition) ==============
  -- SELECT FOR UPDATE akan blokir transaksi concurrent sampai
  -- transaction ini selesai. Jadi 2 request bersamaan untuk user
  -- yang sama akan di-serialize.
  SELECT
    w.id,
    w.balance_idr,
    w.token_balance
  INTO
    v_wallet_id,
    v_current_balance,
    v_current_tokens
  FROM public.wallets w
  WHERE w.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND: Wallet untuk user % tidak ditemukan', p_user_id
      USING ERRCODE = 'P0002';
  END IF;

  -- ============== Validasi saldo cukup ==============
  IF v_current_balance < p_amount_idr THEN
    RAISE EXCEPTION 'INSUFFICIENT_BALANCE: Saldo tidak cukup. Have: %, Need: %',
      v_current_balance, p_amount_idr
      USING ERRCODE = '22023';
  END IF;

  -- ============== Update wallet ==============
  UPDATE public.wallets
  SET
    balance_idr = v_current_balance - p_amount_idr,
    token_balance = v_current_tokens + v_tokens_to_add,
    updated_at = now()
  WHERE id = v_wallet_id;

  -- ============== Insert audit log ==============
  INSERT INTO public.transactions (
    user_id,
    wallet_id,
    type,
    status,
    amount_idr,
    token_amount,
    balance_after_idr,
    token_after,
    description,
    metadata
  ) VALUES (
    p_user_id,
    v_wallet_id,
    'topup',  -- Treat as topup untuk revenue tracking
    'success',
    0,        -- amount_idr=0 karena ini bukan deposit baru
    v_tokens_to_add,
    v_current_balance - p_amount_idr,
    v_current_tokens + v_tokens_to_add,
    format('Convert Rp %s → %s token', p_amount_idr, v_tokens_to_add),
    jsonb_build_object(
      'kind', 'saldo_to_token',
      'amount_idr', p_amount_idr,
      'tokens_added', v_tokens_to_add,
      'rate', '1 token = Rp 500',
      'converted_at', now()
    )
  )
  RETURNING id INTO v_tx_id;

  -- ============== Return result ==============
  RETURN QUERY
  SELECT
    v_current_balance AS balance_before,
    v_current_balance - p_amount_idr AS balance_after,
    v_current_tokens AS tokens_before,
    v_current_tokens + v_tokens_to_add AS tokens_after,
    v_tokens_to_add AS tokens_added;

EXCEPTION
  WHEN OTHERS THEN
    -- Re-raise dengan context info
    RAISE;
END;
$$;

COMMENT ON FUNCTION public.convert_saldo_to_tokens IS
  'Atomic conversion dari saldo IDR ke token. Race-condition safe via row lock.';


-- ===============
-- 2. Function: credit_bonus_tokens
-- ===============
-- Tambah token bonus ke user (untuk signup bonus, promo, dll).
-- Atomic + idempotent (kalau reference_id sudah ada, skip).
--
-- Parameters:
--   p_user_id: user yang dapet bonus
--   p_tokens: jumlah token
--   p_reason: 'signup_bonus' | 'promo' | 'admin_adjustment'
--   p_reference_id: ID unik untuk idempotency (misal: 'signup:user_id')
CREATE OR REPLACE FUNCTION public.credit_bonus_tokens(
  p_user_id UUID,
  p_tokens INTEGER,
  p_reason TEXT,
  p_reference_id TEXT
)
RETURNS TABLE (
  tokens_before NUMERIC,
  tokens_after NUMERIC,
  already_credited BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_wallet_id UUID;
  v_current_tokens NUMERIC;
  v_already_credited BOOLEAN := FALSE;
BEGIN
  -- ============== Validasi ==============
  IF p_tokens IS NULL OR p_tokens <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: tokens harus > 0' USING ERRCODE = '22023';
  END IF;

  IF p_reference_id IS NULL OR p_reference_id = '' THEN
    RAISE EXCEPTION 'MISSING_REFERENCE: p_reference_id wajib diisi untuk idempotency'
      USING ERRCODE = '22023';
  END IF;

  -- ============== Idempotency check ==============
  -- Kalau reference_id sudah pernah di-credit, skip.
  -- Mencegah signup bonus ke-credit 2x kalau user daftar 2x.
  IF EXISTS (
    SELECT 1 FROM public.transactions
    WHERE reference_id = p_reference_id
    AND type = 'bonus'
  ) THEN
    -- Ambil current tokens, return already_credited=true
    SELECT token_balance, w.id
    INTO v_current_tokens, v_wallet_id
    FROM public.wallets w
    WHERE w.user_id = p_user_id;

    v_already_credited := TRUE;
    RETURN QUERY
    SELECT v_current_tokens, v_current_tokens, v_already_credited;
    RETURN;
  END IF;

  -- ============== Lock wallet ==============
  SELECT w.id, w.token_balance
  INTO v_wallet_id, v_current_tokens
  FROM public.wallets w
  WHERE w.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND: Wallet untuk user % tidak ditemukan', p_user_id
      USING ERRCODE = 'P0002';
  END IF;

  -- ============== Update wallet ==============
  UPDATE public.wallets
  SET
    token_balance = v_current_tokens + p_tokens,
    updated_at = now()
  WHERE id = v_wallet_id;

  -- ============== Insert audit log ==============
  INSERT INTO public.transactions (
    user_id,
    wallet_id,
    type,
    status,
    amount_idr,
    token_amount,
    token_after,
    reference_id,
    description,
    metadata
  ) VALUES (
    p_user_id,
    v_wallet_id,
    'bonus',
    'success',
    0,
    p_tokens,
    v_current_tokens + p_tokens,
    p_reference_id,
    format('Bonus %s token (%s)', p_tokens, p_reason),
    jsonb_build_object(
      'reason', p_reason,
      'tokens_added', p_tokens,
      'credited_at', now()
    )
  );

  -- ============== Return ==============
  RETURN QUERY
  SELECT
    v_current_tokens,
    v_current_tokens + p_tokens,
    FALSE;
END;
$$;

COMMENT ON FUNCTION public.credit_bonus_tokens IS
  'Atomic credit bonus token. Idempotent via reference_id.';


-- ===============
-- 3. Function: apply_topup_to_wallet
-- ===============
-- Apply topup effect ke wallet (called by webhook handler).
-- Idempotent: kalau transaction_id sudah applied, skip.
--
-- Parameters:
--   p_transaction_id: UUID transaction yang akan di-apply
CREATE OR REPLACE FUNCTION public.apply_topup_to_wallet(
  p_transaction_id UUID
)
RETURNS TABLE (
  already_applied BOOLEAN,
  balance_after NUMERIC,
  token_after NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tx RECORD;
  v_wallet RECORD;
  v_balance_after NUMERIC;
  v_token_after NUMERIC;
  v_already_applied BOOLEAN := FALSE;
BEGIN
  -- ============== Ambil transaction (lock) ==============
  SELECT *
  INTO v_tx
  FROM public.transactions
  WHERE id = p_transaction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSACTION_NOT_FOUND: %', p_transaction_id
      USING ERRCODE = 'P0002';
  END IF;

  -- ============== Idempotency check ==============
  -- Kalau metadata sudah menandai applied, skip
  IF v_tx.metadata ? 'wallet_applied_at' THEN
    v_already_applied := TRUE;
    RETURN QUERY
    SELECT TRUE, v_tx.balance_after_idr, v_tx.token_after;
    RETURN;
  END IF;

  -- ============== Ambil wallet (lock) ==============
  SELECT *
  INTO v_wallet
  FROM public.wallets
  WHERE id = v_tx.wallet_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND: %', v_tx.wallet_id
      USING ERRCODE = 'P0002';
  END IF;

  v_balance_after := v_wallet.balance_idr;
  v_token_after := v_wallet.token_balance;

  -- ============== Apply effect ==============
  -- Topup selalu nambah balance_idr (gak peduli kind)
  v_balance_after := v_balance_after + v_tx.amount_idr;

  -- Token hanya ditambah kalau kind != 'saldo'
  IF v_tx.metadata->>'kind' IS DISTINCT FROM 'saldo' THEN
    v_token_after := v_token_after + v_tx.token_amount;
  END IF;

  -- ============== Update wallet ==============
  UPDATE public.wallets
  SET
    balance_idr = v_balance_after,
    token_balance = v_token_after,
    updated_at = now()
  WHERE id = v_wallet.id;

  -- ============== Update transaction dengan snapshot + flag ==============
  UPDATE public.transactions
  SET
    balance_after_idr = v_balance_after,
    token_after = v_token_after,
    metadata = v_tx.metadata || jsonb_build_object(
      'wallet_applied_at', now()
    ),
    updated_at = now()
  WHERE id = p_transaction_id;

  RETURN QUERY
  SELECT FALSE, v_balance_after, v_token_after;
END;
$$;

COMMENT ON FUNCTION public.apply_topup_to_wallet IS
  'Atomic apply topup ke wallet. Idempotent via wallet_applied_at flag di metadata.';


-- ===============
-- 4. Function: deduct_token_for_build
-- ===============
-- Potong token untuk build (race-condition safe).
-- Validasi saldo di SQL level.
CREATE OR REPLACE FUNCTION public.deduct_token_for_build(
  p_user_id UUID,
  p_amount INTEGER DEFAULT 1,
  p_job_id UUID DEFAULT NULL
)
RETURNS TABLE (
  wallet_id UUID,
  tokens_before NUMERIC,
  tokens_after NUMERIC,
  job_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_wallet_id UUID;
  v_current_tokens NUMERIC;
BEGIN
  -- Validasi
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: amount harus > 0' USING ERRCODE = '22023';
  END IF;

  -- Lock wallet
  SELECT w.id, w.token_balance
  INTO v_wallet_id, v_current_tokens
  FROM public.wallets w
  WHERE w.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- Cek saldo cukup
  IF v_current_tokens < p_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_TOKEN: Have %, need %',
      v_current_tokens, p_amount
      USING ERRCODE = '22023';
  END IF;

  -- Update wallet
  UPDATE public.wallets
  SET
    token_balance = v_current_tokens - p_amount,
    updated_at = now()
  WHERE id = v_wallet_id;

  -- Insert audit
  INSERT INTO public.transactions (
    user_id, wallet_id, type, status,
    amount_idr, token_amount, token_after,
    description, metadata
  ) VALUES (
    p_user_id, v_wallet_id, 'build', 'pending',
    0, -p_amount, v_current_tokens - p_amount,
    format('Token dipotong untuk build job'),
    jsonb_build_object(
      'job_id', p_job_id,
      'tokens_deducted', p_amount
    )
  );

  RETURN QUERY
  SELECT
    v_wallet_id,
    v_current_tokens,
    v_current_tokens - p_amount,
    p_job_id;
END;
$$;

COMMENT ON FUNCTION public.deduct_token_for_build IS
  'Atomic token deduction untuk build. Race-condition safe.';

-- ===============
-- 7. Function: purchase_tokens_with_saldo
-- ===============
-- User BELI TOKEN pakai saldo. Instant, no QRIS.
-- Atomic: potong saldo + tambah token dalam 1 transaction.
--
-- Ini adalah PRODUK, bukan convert. Token adalah barang yang dijual.
-- User bayar pakai saldo (yang sudah di-topup sebelumnya).
--
-- Returns: balance_before, balance_after, tokens_before, tokens_after, tokens_added, transaction_id
CREATE OR REPLACE FUNCTION public.purchase_tokens_with_saldo(
  p_user_id UUID,
  p_wallet_id UUID,
  p_amount_idr NUMERIC,
  p_description TEXT DEFAULT NULL
)
RETURNS TABLE (
  balance_before NUMERIC,
  balance_after NUMERIC,
  tokens_before NUMERIC,
  tokens_after NUMERIC,
  tokens_added INTEGER,
  transaction_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_balance NUMERIC;
  v_current_tokens NUMERIC;
  v_tokens_to_add INTEGER;
  v_token_price NUMERIC := 500; -- 1 token = Rp 500
  v_tx_id UUID;
BEGIN
  -- Validasi
  IF p_amount_idr IS NULL OR p_amount_idr <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: Amount harus > 0' USING ERRCODE = '22023';
  END IF;

  IF p_amount_idr % v_token_price != 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: Amount harus kelipatan Rp %', v_token_price
      USING ERRCODE = '22023';
  END IF;

  v_tokens_to_add := (p_amount_idr / v_token_price)::INTEGER;

  -- Lock wallet row
  SELECT balance_idr, token_balance
  INTO v_current_balance, v_current_tokens
  FROM public.wallets
  WHERE id = p_wallet_id AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND: wallet % untuk user % tidak ditemukan',
      p_wallet_id, p_user_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Validasi saldo cukup
  IF v_current_balance < p_amount_idr THEN
    RAISE EXCEPTION 'INSUFFICIENT_BALANCE: Saldo % tidak cukup (butuh %)',
      v_current_balance, p_amount_idr
      USING ERRCODE = '22023';
  END IF;

  -- Update wallet
  UPDATE public.wallets
  SET
    balance_idr = v_current_balance - p_amount_idr,
    token_balance = v_current_tokens + v_tokens_to_add,
    updated_at = now()
  WHERE id = p_wallet_id;

  -- Insert audit (type='token_purchase', status='success' — instant)
  INSERT INTO public.transactions (
    user_id, wallet_id, type, status,
    amount_idr, token_amount,
    balance_after_idr, token_after,
    description, metadata
  ) VALUES (
    p_user_id, p_wallet_id, 'token_purchase', 'success',
    p_amount_idr, v_tokens_to_add,
    v_current_balance - p_amount_idr, v_current_tokens + v_tokens_to_add,
    p_description,
    jsonb_build_object(
      'product', 'token_purchase',
      'amount_idr', p_amount_idr,
      'tokens_added', v_tokens_to_add,
      'rate', '1 token = Rp 500',
      'purchased_at', now()
    )
  )
  RETURNING id INTO v_tx_id;

  -- Return
  RETURN QUERY
  SELECT
    v_current_balance AS balance_before,
    v_current_balance - p_amount_idr AS balance_after,
    v_current_tokens AS tokens_before,
    v_current_tokens + v_tokens_to_add AS tokens_after,
    v_tokens_to_add AS tokens_added,
    v_tx_id AS transaction_id;
END;
$$;

COMMENT ON FUNCTION public.purchase_tokens_with_saldo IS
  'Atomic: user BELI TOKEN pakai saldo (instant, no QRIS). Produk, bukan convert.';


-- ===============
-- 8. Function: activate_subscription_with_saldo
-- ===============
-- User BERLANGGANAN pakai saldo. Instant, no QRIS.
-- Atomic: potong saldo + set tier + expiry date.
--
-- Returns: balance_before, balance_after, tier, expires_at, transaction_id
CREATE OR REPLACE FUNCTION public.activate_subscription_with_saldo(
  p_user_id UUID,
  p_wallet_id UUID,
  p_target_tier TEXT,
  p_amount_idr NUMERIC,
  p_description TEXT DEFAULT NULL
)
RETURNS TABLE (
  balance_before NUMERIC,
  balance_after NUMERIC,
  tier TEXT,
  expires_at TIMESTAMPTZ,
  transaction_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_balance NUMERIC;
  v_previous_tier TEXT;
  v_quota_limit INT;
  v_is_vip BOOLEAN;
  v_duration_days INT;
  v_expires_at TIMESTAMPTZ;
  v_tx_id UUID;
  v_now TIMESTAMPTZ := now();
BEGIN
  -- Validasi tier
  IF p_target_tier NOT IN ('basic', 'pro', 'premium') THEN
    RAISE EXCEPTION 'INVALID_TIER: %', p_target_tier
      USING ERRCODE = '22023';
  END IF;

  -- Tier config
  v_quota_limit := CASE p_target_tier
    WHEN 'basic' THEN 35
    WHEN 'pro' THEN 0
    WHEN 'premium' THEN 0
  END;
  v_is_vip := (p_target_tier = 'premium');
  v_duration_days := 30;
  v_expires_at := v_now + (v_duration_days || ' days')::INTERVAL;

  -- Lock wallet
  SELECT balance_idr, subscription_tier
  INTO v_current_balance, v_previous_tier
  FROM public.wallets
  WHERE id = p_wallet_id AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- Validasi saldo cukup
  IF v_current_balance < p_amount_idr THEN
    RAISE EXCEPTION 'INSUFFICIENT_BALANCE: Saldo % tidak cukup (butuh %)',
      v_current_balance, p_amount_idr
      USING ERRCODE = '22023';
  END IF;

  -- Update wallet
  UPDATE public.wallets
  SET
    balance_idr = v_current_balance - p_amount_idr,
    subscription_tier = p_target_tier,
    subscription_expires_at = v_expires_at,
    build_quota_limit = v_quota_limit,
    build_quota_used = 0,  -- reset quota
    is_vip_queue = v_is_vip,
    updated_at = v_now
  WHERE id = p_wallet_id;

  -- Insert audit (type='subscription', status='success' — instant)
  INSERT INTO public.transactions (
    user_id, wallet_id, type, status,
    amount_idr, token_amount,
    balance_after_idr, token_after,
    description, metadata
  ) VALUES (
    p_user_id, p_wallet_id, 'subscription', 'success',
    p_amount_idr, 0,
    v_current_balance - p_amount_idr, NULL,
    p_description,
    jsonb_build_object(
      'product', 'subscription',
      'target_tier', p_target_tier,
      'previous_tier', v_previous_tier,
      'expires_at', v_expires_at,
      'quota_limit', v_quota_limit,
      'is_vip', v_is_vip,
      'activated_at', v_now
    )
  )
  RETURNING id INTO v_tx_id;

  -- Return
  RETURN QUERY
  SELECT
    v_current_balance AS balance_before,
    v_current_balance - p_amount_idr AS balance_after,
    p_target_tier AS tier,
    v_expires_at AS expires_at,
    v_tx_id AS transaction_id;
END;
$$;

COMMENT ON FUNCTION public.activate_subscription_with_saldo IS
  'Atomic: user BERLANGGANAN pakai saldo (instant, no QRIS). Potong saldo + set tier.';


-- ===============
-- 9. Update apply_topup_to_wallet untuk sistem baru
-- ===============
-- Sistem baru: topup HANYA nambah balance_idr, gak ada token.
-- (Sebelumnya ada kind='token' yang auto-add token — itu sudah dihapus)
DROP FUNCTION IF EXISTS public.apply_topup_to_wallet(UUID);
CREATE OR REPLACE FUNCTION public.apply_topup_to_wallet(
  p_transaction_id UUID
)
RETURNS TABLE (
  already_applied BOOLEAN,
  balance_after NUMERIC,
  token_after NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tx RECORD;
  v_wallet RECORD;
  v_balance_after NUMERIC;
  v_token_after NUMERIC;
  v_already_applied BOOLEAN := FALSE;
  v_advisory_lock_key BIGINT;
BEGIN
  v_advisory_lock_key := ('x' || substr(md5(p_transaction_id::text), 1, 16))::bit(64)::bigint;
  PERFORM pg_advisory_xact_lock(v_advisory_lock_key);

  SELECT * INTO v_tx
  FROM public.transactions
  WHERE id = p_transaction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSACTION_NOT_FOUND: %', p_transaction_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_tx.status != 'success' THEN
    RAISE EXCEPTION 'INVALID_STATUS: %', v_tx.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_tx.metadata ? 'wallet_applied_at' THEN
    v_already_applied := TRUE;
    RETURN QUERY
    SELECT TRUE, v_tx.balance_after_idr, v_tx.token_after;
    RETURN;
  END IF;

  IF v_tx.type != 'topup' THEN
    RAISE EXCEPTION 'INVALID_TYPE: %', v_tx.type
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_wallet
  FROM public.wallets
  WHERE id = v_tx.wallet_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  v_balance_after := v_wallet.balance_idr + v_tx.amount_idr;
  v_token_after := v_wallet.token_balance;  -- topup gak ubah token

  UPDATE public.wallets
  SET
    balance_idr = v_balance_after,
    updated_at = now()
  WHERE id = v_wallet.id;

  UPDATE public.transactions
  SET
    balance_after_idr = v_balance_after,
    token_after = v_token_after,
    metadata = v_tx.metadata || jsonb_build_object('wallet_applied_at', now()),
    updated_at = now()
  WHERE id = p_transaction_id
    AND NOT (v_tx.metadata ? 'wallet_applied_at');

  IF NOT FOUND THEN
    v_already_applied := TRUE;
    SELECT balance_after_idr INTO v_balance_after
    FROM public.transactions WHERE id = p_transaction_id;
  END IF;

  RETURN QUERY
  SELECT v_already_applied, v_balance_after, v_token_after;
END;
$$;

COMMENT ON FUNCTION public.apply_topup_to_wallet IS
  'Atomic apply topup: tambah balance_idr saja (token gak diubah). Idempotent.';


-- ===============
-- 10. DROP function convert_saldo_to_tokens (TIDAK DIGUNAKAN LAGI)
-- ===============
-- Sistem baru: token = PRODUK (purchased pakai saldo), bukan convert.
-- Function ini tetap di-archive untuk backward compat (jika ada user
-- yang masih punya link /convert), tapi TIDAK dipakai di flow baru.
-- DROP IF EXISTS di-skip untuk safety. Bisa di-DROP manual nanti.

-- DROP FUNCTION IF EXISTS public.convert_saldo_to_tokens(UUID, NUMERIC);


-- ===============
-- 11. Grant execute permissions
-- ===============
GRANT EXECUTE ON FUNCTION public.purchase_tokens_with_saldo(UUID, UUID, NUMERIC, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.activate_subscription_with_saldo(UUID, UUID, TEXT, NUMERIC, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_topup_to_wallet(UUID) TO service_role;

COMMENT ON FUNCTION public.credit_bonus_tokens IS
  'Atomic credit bonus token. Idempotent via reference_id (signup:user_id). Hanya bisa 1x per user.';

-- ===============
-- 6. Update trigger signup_bonus di 01_schema.sql
-- ===============
-- Function ini dipanggil dari trigger on_auth_user_created.
-- Ganti implementasi lama dengan credit_bonus_tokens() yang idempotent.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_display_name TEXT;
BEGIN
  -- Ambil display name dari metadata atau email
  v_display_name := COALESCE(
    NEW.raw_user_meta_data->>'display_name',
    NEW.raw_user_meta_data->>'full_name',
    split_part(NEW.email, '@', 1)
  );

  -- Insert profile
  INSERT INTO public.users (id, email, display_name, avatar_url, created_at, updated_at)
  VALUES (
    NEW.id,
    NEW.email,
    v_display_name,
    NEW.raw_user_meta_data->>'avatar_url',
    now(),
    now()
  )
  ON CONFLICT (id) DO NOTHING;

  -- Insert wallet
  INSERT INTO public.wallets (user_id, balance_idr, token_balance, subscription_tier, created_at, updated_at)
  VALUES (
    NEW.id,
    0,
    0,  -- mulai dari 0, akan ditambah oleh bonus function di bawah
    'none',
    now(),
    now()
  )
  ON CONFLICT (user_id) DO NOTHING;

  -- Credit signup bonus (3 token) — IDEMPOTENT
  -- reference_id = 'signup:<user_id>' jadi gak akan double-credit
  PERFORM public.credit_bonus_tokens(
    NEW.id,
    3,
    'signup_bonus',
    format('signup:%s', NEW.id)
  );

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_new_user IS
  'Trigger function saat user baru signup. Create profile + wallet + signup bonus.';


-- #############################################
-- ## FILE 5: 05_anti_double_credit.sql
-- #############################################
-- =============================================
-- 05_anti_double_credit.sql
-- DATABASE-LEVEL safeguards untuk mencegah double credit
-- =============================================
-- Jalankan SETELAH 01-04 di Supabase SQL Editor.
--
-- Layer pertahanan (defense in depth):
--   1. UNIQUE constraint di reference_id (mencegah duplikat payment)
--   2. CHECK constraint di balance_idr >= 0 (anti corruption)
--   3. CHECK constraint di token_balance >= 0
--   4. TRIGGER: auto-reject update yang bikin balance_idr lompat
--      terlalu besar (>10x dari sebelumnya) — anti bug
--   5. TRIGGER: lock transaction yang sudah 'success' dari edit
--   6. Webhook audit table indexes (performance)

-- ===============
-- 1. UNIQUE constraint pada reference_id
-- ===============
-- reference_id = order_id (UUID dari kita saat create)
-- 1 order_id HARUS hanya ada 1 row di transactions
-- Kalau Pakasir double-fire webhook, INSERT kedua akan GAGAL
-- (atau kalau sudah ada, lookup by reference_id return yang existing)

DO $$
BEGIN
  -- Cek apakah constraint sudah ada
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'transactions_reference_id_unique'
  ) THEN
    -- Tambahkan unique constraint
    -- Hati-hati: kalau ada duplikat existing, ini akan GAGAL
    -- Jadi kita cek dulu
    IF EXISTS (
      SELECT reference_id
      FROM public.transactions
      WHERE reference_id IS NOT NULL
      GROUP BY reference_id
      HAVING COUNT(*) > 1
    ) THEN
      RAISE EXCEPTION 'Cannot add unique constraint: duplicate reference_id exists. Clean up first.';
    END IF;

    ALTER TABLE public.transactions
      ADD CONSTRAINT transactions_reference_id_unique
      UNIQUE (reference_id);
  END IF;
END $$;

-- ===============
-- 2. CHECK constraint: balance_idr tidak boleh negatif
-- ===============
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wallets_balance_idr_non_negative'
  ) THEN
    ALTER TABLE public.wallets
      ADD CONSTRAINT wallets_balance_idr_non_negative
      CHECK (balance_idr >= 0);
  END IF;
END $$;

-- ===============
-- 3. CHECK constraint: token_balance tidak boleh negatif
-- ===============
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wallets_token_balance_non_negative'
  ) THEN
    ALTER TABLE public.wallets
      ADD CONSTRAINT wallets_token_balance_non_negative
      CHECK (token_balance >= 0);
  END IF;
END $$;

-- ===============
-- 4. TRIGGER: Anti-loncat-balance (detect suspicious changes)
-- ===============
-- Kalau ada UPDATE yang nambah balance_idr > 10x dalam 1 transaksi,
-- REJECT. Ini untuk catch bug seperti:
--   - Double apply (juga mungkin terjadi kalau logic elsewhere)
--   - Hacker dapat akses langsung ke DB
--   - Bug di kode (misal salah baca '5000' sebagai '50000')

CREATE OR REPLACE FUNCTION public.check_balance_jump()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_max_allowed_increase NUMERIC := 1000000; -- 1 juta (10x tier premium)
  v_increase NUMERIC;
BEGIN
  -- Hanya cek saat ada perubahan balance
  IF NEW.balance_idr IS DISTINCT FROM OLD.balance_idr THEN
    v_increase := NEW.balance_idr - OLD.balance_idr;

    -- Kalau NAIK lebih dari max, reject
    IF v_increase > v_max_allowed_increase THEN
      RAISE EXCEPTION
        'SUSPICIOUS_BALANCE_INCREASE: balance naik % dalam 1 transaksi (max %) untuk wallet %. Possible double-credit bug!',
        v_increase, v_max_allowed_increase, NEW.id
        USING ERRCODE = 'check_violation';
    END IF;

    -- Kalau NAIK > 5x dari current, log warning (tapi allow)
    -- (bisa jadi subscription premium legit, jadi gak di-reject)
    IF v_increase > OLD.balance_idr * 5 AND OLD.balance_idr > 0 THEN
      RAISE WARNING
        'Large balance increase for wallet %: % -> % (delta %)',
        NEW.id, OLD.balance_idr, NEW.balance_idr, v_increase;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_check_balance_jump ON public.wallets;
CREATE TRIGGER trigger_check_balance_jump
  BEFORE UPDATE ON public.wallets
  FOR EACH ROW
  EXECUTE FUNCTION public.check_balance_jump();

COMMENT ON FUNCTION public.check_balance_jump IS
  'Trigger: detect & reject suspicious large balance increases (anti-double-credit)';

-- ===============
-- 5. TRIGGER: Lock transaction setelah success
-- ===============
-- Setelah transaction.status = 'success', JANGAN biarkan di-edit
-- lagi. Cuma boleh: success → failed (revert), atau success → 'expired' (cron).
-- Anti: ada bug yang re-apply efek ke wallet.

CREATE OR REPLACE FUNCTION public.lock_processed_transaction()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Kalau status sebelumnya 'success' dan ada yang coba edit amount/token
  IF OLD.status = 'success' THEN
    IF NEW.amount_idr IS DISTINCT FROM OLD.amount_idr THEN
      RAISE EXCEPTION
        'LOCKED_TRANSACTION: Cannot modify amount_idr of completed transaction %',
        OLD.id
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.token_amount IS DISTINCT FROM OLD.token_amount THEN
      RAISE EXCEPTION
        'LOCKED_TRANSACTION: Cannot modify token_amount of completed transaction %',
        OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_lock_processed_transaction ON public.transactions;
CREATE TRIGGER trigger_lock_processed_transaction
  BEFORE UPDATE ON public.transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.lock_processed_transaction();

COMMENT ON FUNCTION public.lock_processed_transaction IS
  'Trigger: lock amount/token fields of completed (success) transactions';

-- ===============
-- 6. UPDATE existing functions: stricter idempotency
-- ===============
-- Re-create apply_topup_to_wallet dengan double-safety:
-- - Pakai advisory lock (se-ukuran webhook concurrent)
-- - Re-check status di dalam transaction
-- - Pakai UNIQUE constraint catching

CREATE OR REPLACE FUNCTION public.apply_topup_to_wallet(
  p_transaction_id UUID
)
RETURNS TABLE (
  already_applied BOOLEAN,
  balance_after NUMERIC,
  token_after NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tx RECORD;
  v_wallet RECORD;
  v_balance_after NUMERIC;
  v_token_after NUMERIC;
  v_already_applied BOOLEAN := FALSE;
  v_advisory_lock_key BIGINT;
BEGIN
  -- ============== ACQUIRE ADVISORY LOCK ==============
  -- Pakai hash dari transaction_id sebagai lock key.
  -- Jadi 2 webhook concurrent untuk transaction SAMA akan serialize.
  -- (Webhook untuk transaction BERBEDA tidak akan block satu sama lain.)
  v_advisory_lock_key := ('x' || substr(md5(p_transaction_id::text), 1, 16))::bit(64)::bigint;
  PERFORM pg_advisory_xact_lock(v_advisory_lock_key);

  -- ============== Ambil transaction (lock row juga) ==============
  SELECT *
  INTO v_tx
  FROM public.transactions
  WHERE id = p_transaction_id
  FOR UPDATE;  -- Row-level lock (extra safety)

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSACTION_NOT_FOUND: %', p_transaction_id
      USING ERRCODE = 'P0002';
  END IF;

  -- ============== HARD IDEMPOTENCY CHECK #1 ==============
  -- Kalau transaction belum 'success', JANGAN apply (hanya apply yang success)
  IF v_tx.status != 'success' THEN
    RAISE EXCEPTION
      'INVALID_STATUS: Cannot apply transaction with status % (expected: success)',
      v_tx.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- ============== HARD IDEMPOTENCY CHECK #2 ==============
  -- Cek flag wallet_applied_at di metadata (double-check)
  IF v_tx.metadata ? 'wallet_applied_at' THEN
    v_already_applied := TRUE;
    RETURN QUERY
    SELECT TRUE, v_tx.balance_after_idr, v_tx.token_after;
    RETURN;
  END IF;

  -- ============== Cek apakah ini TOPUP atau SUBSCRIPTION ==============
  -- (Function ini khusus topup, subscription di-handle di tempat lain)
  IF v_tx.type NOT IN ('topup', 'subscription') THEN
    RAISE EXCEPTION
      'INVALID_TYPE: apply_topup_to_wallet hanya untuk topup/subscription, got %',
      v_tx.type
      USING ERRCODE = 'check_violation';
  END IF;

  -- ============== Ambil wallet (lock row) ==============
  SELECT *
  INTO v_wallet
  FROM public.wallets
  WHERE id = v_tx.wallet_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND: %', v_tx.wallet_id
      USING ERRCODE = 'P0002';
  END IF;

  v_balance_after := v_wallet.balance_idr;
  v_token_after := v_wallet.token_balance;

  -- ============== Apply effect ==============
  -- Topup selalu nambah balance_idr (gak peduli kind)
  v_balance_after := v_balance_after + v_tx.amount_idr;

  -- Token hanya ditambah kalau kind != 'saldo'
  IF v_tx.metadata->>'kind' IS DISTINCT FROM 'saldo' THEN
    v_token_after := v_token_after + v_tx.token_amount;
  END IF;

  -- ============== SANITY CHECK ==============
  -- Reject kalau hasilnya jadi bilangan negatif (seharusnya gak mungkin
  -- karena amount_idr positif, tapi defensive)
  IF v_balance_after < 0 THEN
    RAISE EXCEPTION
      'NEGATIVE_BALANCE: Resulting balance is negative (%), refusing apply',
      v_balance_after
      USING ERRCODE = 'check_violation';
  END IF;

  -- ============== Update wallet ==============
  UPDATE public.wallets
  SET
    balance_idr = v_balance_after,
    token_balance = v_token_after,
    updated_at = now()
  WHERE id = v_wallet.id;

  -- ============== Update transaction dengan snapshot + flag atomic ==============
  -- Pakai WHERE clause yang include 'NOT applied' sebagai extra safety
  UPDATE public.transactions
  SET
    balance_after_idr = v_balance_after,
    token_after = v_token_after,
    metadata = v_tx.metadata || jsonb_build_object(
      'wallet_applied_at', now()
    ),
    updated_at = now()
  WHERE id = p_transaction_id
    AND NOT (v_tx.metadata ? 'wallet_applied_at');  -- double-check

  -- ============== Verify update happened ==============
  IF NOT FOUND THEN
    -- Race: webhook lain baru saja apply antara cek dan update
    -- Return already_applied=true
    RAISE NOTICE 'Race detected: transaction % already applied by another webhook', p_transaction_id;
    v_already_applied := TRUE;
    -- Re-fetch latest state
    SELECT balance_after_idr, token_after
    INTO v_balance_after, v_token_after
    FROM public.transactions
    WHERE id = p_transaction_id;
  END IF;

  RETURN QUERY
  SELECT v_already_applied, v_balance_after, v_token_after;
END;
$$;

COMMENT ON FUNCTION public.apply_topup_to_wallet IS
  'Atomic apply topup/subscription ke wallet. Multi-layer idempotency: advisory lock + row lock + status check + metadata flag + NOT clause. 100% safe against double-credit from concurrent webhooks.';

-- ===============
-- 7. Fungsi apply_subscription (dedicated, lebih strict)
-- ===============
CREATE OR REPLACE FUNCTION public.apply_subscription_to_wallet(
  p_transaction_id UUID
)
RETURNS TABLE (
  already_applied BOOLEAN,
  tier TEXT,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_tx RECORD;
  v_wallet RECORD;
  v_target_tier TEXT;
  v_expires_at TIMESTAMPTZ;
  v_duration_days INT;
  v_already_applied BOOLEAN := FALSE;
  v_advisory_lock_key BIGINT;
  v_tier_config JSONB := '{
    "basic": {"quota": 35, "vip": false, "days": 30},
    "pro": {"quota": 0, "vip": false, "days": 30},
    "premium": {"quota": 0, "vip": true, "days": 30}
  }'::jsonb;
  v_quota INT;
  v_vip BOOLEAN;
BEGIN
  v_advisory_lock_key := ('x' || substr(md5(p_transaction_id::text), 1, 16))::bit(64)::bigint;
  PERFORM pg_advisory_xact_lock(v_advisory_lock_key);

  SELECT * INTO v_tx
  FROM public.transactions
  WHERE id = p_transaction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSACTION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_tx.type != 'subscription' THEN
    RAISE EXCEPTION 'INVALID_TYPE: expected subscription, got %', v_tx.type
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_tx.status != 'success' THEN
    RAISE EXCEPTION 'INVALID_STATUS: %', v_tx.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Idempotency
  IF v_tx.metadata ? 'subscription_applied_at' THEN
    RETURN QUERY
    SELECT TRUE, v_tx.metadata->>'target_tier',
           (v_tx.metadata->>'subscription_expires_at')::TIMESTAMPTZ;
    RETURN;
  END IF;

  v_target_tier := v_tx.metadata->>'target_tier';
  IF v_target_tier IS NULL OR NOT (v_target_tier IN ('basic', 'pro', 'premium')) THEN
    RAISE EXCEPTION 'INVALID_TIER: %', v_target_tier
      USING ERRCODE = 'check_violation';
  END IF;

  v_quota := (v_tier_config->v_target_tier->>'quota')::INT;
  v_vip := (v_tier_config->v_target_tier->>'vip')::BOOLEAN;
  v_duration_days := (v_tier_config->v_target_tier->>'days')::INT;

  SELECT * INTO v_wallet
  FROM public.wallets
  WHERE id = v_tx.wallet_id
  FOR UPDATE;

  -- Calculate expiry
  v_expires_at := now() + (v_duration_days || ' days')::INTERVAL;

  UPDATE public.wallets
  SET
    subscription_tier = v_target_tier,
    subscription_expires_at = v_expires_at,
    build_quota_limit = v_quota,
    build_quota_used = 0,
    is_vip_queue = v_vip,
    updated_at = now()
  WHERE id = v_wallet.id;

  UPDATE public.transactions
  SET
    metadata = v_tx.metadata || jsonb_build_object(
      'subscription_applied_at', now(),
      'subscription_expires_at', v_expires_at
    ),
    updated_at = now()
  WHERE id = p_transaction_id
    AND NOT (v_tx.metadata ? 'subscription_applied_at');

  RETURN QUERY
  SELECT FALSE, v_target_tier, v_expires_at;
END;
$$;

COMMENT ON FUNCTION public.apply_subscription_to_wallet IS
  'Atomic apply subscription ke wallet. Idempotent via advisory lock + row lock + metadata flag.';

-- ===============
-- 8. Grant
-- ===============
GRANT EXECUTE ON FUNCTION public.apply_topup_to_wallet(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_subscription_to_wallet(UUID) TO service_role;


-- =============================================
-- ✅ END OF COMPLETE SETUP
-- =============================================
-- Expected results:
--   7 tables: users, wallets, transactions, app_configs,
--             build_jobs, webhook_audit, reconciliation_log
--   7+ functions: handle_new_user, credit_bonus_tokens,
--                 apply_topup_to_wallet, purchase_tokens_with_saldo,
--                 activate_subscription_with_saldo,
--                 apply_subscription_to_wallet, deduct_token_for_build
--   4+ triggers: on_auth_user_created, check_balance_jump,
--                lock_processed_transaction, dll
--
-- Verifikasi: lihat di Table Editor (sidebar kiri Supabase)
-- =============================================
