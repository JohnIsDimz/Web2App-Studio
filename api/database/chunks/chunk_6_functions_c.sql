-- =============================================
-- CHUNK 6/7: 04_atomic_functions.sql (Part C)
-- Jalankan SETELAH chunk 5 sukses
-- Function: activate_subscription_with_saldo,
--           apply_topup_to_wallet (update),
--           handle_new_user + GRANT EXECUTE
-- =============================================

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
