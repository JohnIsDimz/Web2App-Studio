-- =============================================
-- CHUNK 5/7: 04_atomic_functions.sql (Part B)
-- Jalankan SETELAH chunk 4 sukses
-- Function: apply_topup_to_wallet, deduct_token_for_build,
--           purchase_tokens_with_saldo
-- =============================================

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
