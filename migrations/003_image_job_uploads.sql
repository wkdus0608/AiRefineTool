ALTER TABLE image_jobs
  ADD COLUMN IF NOT EXISTS input_image_url text,
  ADD COLUMN IF NOT EXISTS result_image_url text,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS input_file_size integer,
  ADD COLUMN IF NOT EXISTS input_mime_type text;
