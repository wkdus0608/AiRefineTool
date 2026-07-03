CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_signup_credit_once_idx
  ON credit_ledger (user_id)
  WHERE reason = 'signup_credit';
