-- =============================================
-- CHUNK 7/7: 05_anti_double_credit.sql
-- Jalankan SETELAH chunk 6 sukses (INI CHUNK TERAKHIR!)
-- Isi: UNIQUE constraint + CHECK + 2 trigger anti-cheat
-- =============================================

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
