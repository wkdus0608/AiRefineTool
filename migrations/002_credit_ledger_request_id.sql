ALTER TABLE credit_ledger
  ADD COLUMN IF NOT EXISTS request_id text;

CREATE INDEX IF NOT EXISTS idx_credit_ledger_request_id ON credit_ledger (request_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_one_debit_per_job
  ON credit_ledger (image_job_id)
  WHERE reason = 'image_job_debit' AND image_job_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_one_refund_per_job
  ON credit_ledger (image_job_id)
  WHERE reason = 'image_job_refund' AND image_job_id IS NOT NULL;
