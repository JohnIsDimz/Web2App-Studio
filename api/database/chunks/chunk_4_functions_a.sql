-- =============================================
-- CHUNK 4/7: 04_atomic_functions.sql (Part A)
-- Jalankan SETELAH chunk 3 sukses
-- Function: convert_saldo_to_tokens, credit_bonus_tokens
-- =============================================

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
