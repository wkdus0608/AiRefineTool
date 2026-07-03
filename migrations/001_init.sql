CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS "session" (
  sid varchar NOT NULL PRIMARY KEY,
  sess json NOT NULL,
  expire timestamp(6) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_expire ON "session" (expire);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  email_normalized text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  display_name text,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_account_id text NOT NULL,
  email text,
  raw_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_account_id)
);

CREATE INDEX IF NOT EXISTS idx_oauth_accounts_user_id ON oauth_accounts (user_id);

CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  order_id text NOT NULL,
  payment_key text,
  amount integer NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'KRW',
  status text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, order_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_payment_key_unique
  ON payments (provider, payment_key)
  WHERE payment_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments (user_id);

CREATE TABLE IF NOT EXISTS image_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  input_file_name text,
  result_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (user_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_image_jobs_user_id ON image_jobs (user_id);
CREATE INDEX IF NOT EXISTS idx_image_jobs_status ON image_jobs (status);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  image_job_id uuid REFERENCES image_jobs(id) ON DELETE SET NULL,
  request_id text,
  payment_id uuid REFERENCES payments(id) ON DELETE SET NULL,
  amount integer NOT NULL CHECK (amount <> 0),
  reason text NOT NULL,
  idempotency_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_id ON credit_ledger (user_id);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_image_job_id ON credit_ledger (image_job_id);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_request_id ON credit_ledger (request_id);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_payment_id ON credit_ledger (payment_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_one_debit_per_job
  ON credit_ledger (image_job_id)
  WHERE reason = 'image_job_debit' AND image_job_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_one_refund_per_job
  ON credit_ledger (image_job_id)
  WHERE reason = 'image_job_refund' AND image_job_id IS NOT NULL;

CREATE OR REPLACE FUNCTION prevent_credit_ledger_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS credit_ledger_no_update ON credit_ledger;
CREATE TRIGGER credit_ledger_no_update
  BEFORE UPDATE ON credit_ledger
  FOR EACH ROW
  EXECUTE FUNCTION prevent_credit_ledger_mutation();

DROP TRIGGER IF EXISTS credit_ledger_no_delete ON credit_ledger;
CREATE TRIGGER credit_ledger_no_delete
  BEFORE DELETE ON credit_ledger
  FOR EACH ROW
  EXECUTE FUNCTION prevent_credit_ledger_mutation();
