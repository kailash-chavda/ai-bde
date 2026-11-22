-- Portfolio / external provenance for case studies (zero-hallucination grounding)
ALTER TABLE case_studies
  ADD COLUMN IF NOT EXISTS source_url text;

COMMENT ON COLUMN case_studies.source_url IS
  'Public source URL for claims (e.g. portfolio page). Never invent metrics beyond this source.';
