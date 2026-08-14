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
