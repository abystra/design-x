CREATE INDEX render_cache_lookup_idx ON jobs(workspace_id,(result->>'cacheKey'),created_at DESC)
 WHERE kind='render.export' AND status='succeeded';
