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
