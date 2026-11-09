-- Additive v2 storage: old assets continue to resolve until verified migration.
CREATE TABLE asset_versions (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id),
 asset_id text NOT NULL REFERENCES assets(id), object_key text NOT NULL,
 thumbnail_key text, bucket text NOT NULL, bytes bigint NOT NULL CHECK(bytes>=0),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), mime text NOT NULL,
 width integer, height integer, source jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(asset_id,id), UNIQUE(bucket,object_key)
);
ALTER TABLE assets ADD COLUMN current_version_id text REFERENCES asset_versions(id);
ALTER TABLE assets ADD COLUMN storage_bucket text;
CREATE INDEX asset_versions_asset_idx ON asset_versions(asset_id,created_at DESC);
CREATE TABLE project_assets (
 workspace_id text NOT NULL REFERENCES workspaces(id), project_id text NOT NULL REFERENCES projects(id),
 asset_id text NOT NULL REFERENCES assets(id), version_id text,
 created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
 PRIMARY KEY(project_id,asset_id), FOREIGN KEY(asset_id,version_id) REFERENCES asset_versions(asset_id,id)
);
CREATE TABLE upload_sessions (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), asset_id text NOT NULL REFERENCES assets(id),
 project_id text REFERENCES projects(id), staging_bucket text NOT NULL, staging_key text NOT NULL UNIQUE,
 filename text NOT NULL, mime text NOT NULL, expected_bytes bigint NOT NULL CHECK(expected_bytes>0),
 expected_sha256 text CHECK(expected_sha256 ~ '^[a-f0-9]{64}$'),
 status text NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','processing','ready','failed','expired')),
 job_id text REFERENCES jobs(id), expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, error text
);
CREATE TABLE storage_candidates (
 workspace_id text NOT NULL REFERENCES workspaces(id), bucket text NOT NULL, object_key text NOT NULL,
 purpose text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(bucket,object_key)
);
CREATE TABLE storage_migrations (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), asset_id text NOT NULL REFERENCES assets(id),
 version_id text REFERENCES asset_versions(id), old_bucket text NOT NULL, old_object_key text NOT NULL,
 old_thumbnail_key text, old_version_id text, status text NOT NULL CHECK(status IN ('copied','switched','rolled_back')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['asset_versions','project_assets','upload_sessions','storage_candidates','storage_migrations'] LOOP
   EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
   EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
   EXECUTE format('CREATE POLICY workspace_isolation ON %I USING (workspace_id = current_setting(''app.workspace_id'',true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'',true))',t);
   EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO designx_tenant',t);
 END LOOP;
END $$;
CREATE FUNCTION reject_asset_version_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Asset versions are immutable'; END $$;
CREATE TRIGGER immutable_asset_versions BEFORE UPDATE ON asset_versions FOR EACH ROW EXECUTE FUNCTION reject_asset_version_update();
INSERT INTO project_assets(workspace_id,project_id,asset_id)
 SELECT DISTINCT r.workspace_id,d.project_id,r.asset_id FROM asset_refs r JOIN documents d ON d.id=r.document_id
 ON CONFLICT DO NOTHING;
