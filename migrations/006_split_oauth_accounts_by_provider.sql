ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_email_normalized_key;

DROP INDEX IF EXISTS users_email_normalized_key;

CREATE INDEX IF NOT EXISTS idx_users_email_normalized
  ON users (email_normalized);

DO $$
DECLARE
  account record;
  account_email text;
  new_user_id uuid;
BEGIN
  FOR account IN
    WITH ranked_accounts AS (
      SELECT
        oa.id,
        oa.user_id,
        oa.provider,
        oa.provider_account_id,
        oa.email,
        oa.raw_profile,
        oa.created_at,
        u.email AS fallback_email,
        row_number() OVER (
          PARTITION BY oa.user_id
          ORDER BY oa.created_at, oa.id
        ) AS account_rank,
        count(*) OVER (PARTITION BY oa.user_id) AS account_count
      FROM oauth_accounts oa
      JOIN users u ON u.id = oa.user_id
    )
    SELECT *
    FROM ranked_accounts
    WHERE account_count > 1
      AND account_rank > 1
    ORDER BY user_id, account_rank, id
  LOOP
    new_user_id := gen_random_uuid();
    account_email := COALESCE(NULLIF(account.email, ''), account.fallback_email);

    INSERT INTO users (
      id,
      email,
      email_normalized,
      email_verified,
      display_name,
      avatar_url
    )
    VALUES (
      new_user_id,
      account_email,
      lower(account_email),
      true,
      COALESCE(
        account.raw_profile #>> '{kakao_account,profile,nickname}',
        account.raw_profile #>> '{response,name}',
        account.raw_profile #>> '{response,nickname}',
        account.raw_profile ->> 'name',
        account_email
      ),
      COALESCE(
        account.raw_profile #>> '{kakao_account,profile,profile_image_url}',
        account.raw_profile #>> '{kakao_account,profile,thumbnail_image_url}',
        account.raw_profile #>> '{response,profile_image}',
        account.raw_profile ->> 'picture'
      )
    );

    UPDATE oauth_accounts
    SET
      user_id = new_user_id,
      updated_at = now()
    WHERE id = account.id;

    INSERT INTO credit_ledger (
      user_id,
      amount,
      reason,
      idempotency_key,
      metadata
    )
    VALUES (
      new_user_id,
      2,
      'signup_credit',
      'signup:user:' || new_user_id,
      jsonb_build_object(
        'provider', account.provider,
        'providerAccountId', account.provider_account_id,
        'splitFromUserId', account.user_id,
        'splitFromOAuthAccountId', account.id
      )
    )
    ON CONFLICT (user_id, idempotency_key) DO NOTHING;
  END LOOP;
END $$;
