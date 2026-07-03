ALTER TABLE image_jobs
  ADD COLUMN IF NOT EXISTS input_storage_path text,
  ADD COLUMN IF NOT EXISTS result_storage_path text;

CREATE INDEX IF NOT EXISTS idx_image_jobs_input_storage_path
  ON image_jobs (input_storage_path)
  WHERE input_storage_path IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_image_jobs_result_storage_path
  ON image_jobs (result_storage_path)
  WHERE result_storage_path IS NOT NULL;
