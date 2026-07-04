CREATE TABLE IF NOT EXISTS image_job_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  image_job_id uuid NOT NULL REFERENCES image_jobs(id) ON DELETE CASCADE,
  variant_key text NOT NULL,
  prompt_key text NOT NULL,
  prompt text,
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'completed',
  result_image_url text,
  result_storage_path text,
  result_mime_type text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (image_job_id, variant_key)
);

CREATE INDEX IF NOT EXISTS idx_image_job_results_image_job_id
  ON image_job_results (image_job_id);

CREATE INDEX IF NOT EXISTS idx_image_job_results_result_storage_path
  ON image_job_results (result_storage_path)
  WHERE result_storage_path IS NOT NULL;

INSERT INTO image_job_results (
  image_job_id,
  variant_key,
  prompt_key,
  prompt,
  provider,
  status,
  result_storage_path,
  result_mime_type,
  metadata,
  completed_at
)
SELECT
  id,
  'version-1',
  'legacy',
  NULL,
  COALESCE(result_metadata->>'provider', result_metadata->>'processor', 'legacy'),
  status,
  result_storage_path,
  input_mime_type,
  result_metadata,
  completed_at
FROM image_jobs
WHERE result_storage_path IS NOT NULL
ON CONFLICT (image_job_id, variant_key) DO NOTHING;
