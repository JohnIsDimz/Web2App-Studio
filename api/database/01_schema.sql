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
