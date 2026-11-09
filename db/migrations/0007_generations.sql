CREATE TABLE creative_requests (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), project_id text NOT NULL REFERENCES projects(id),
 snapshot jsonb NOT NULL, execution_status text NOT NULL DEFAULT 'queued', asset_status text NOT NULL DEFAULT 'pending',
 cancel_requested boolean NOT NULL DEFAULT false, settlement_status text NOT NULL DEFAULT 'pending',
 error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX creative_requests_project_idx ON creative_requests(project_id,created_at DESC);
CREATE TABLE generation_attempts (
 id text PRIMARY KEY REFERENCES jobs(id), workspace_id text NOT NULL REFERENCES workspaces(id), request_id text NOT NULL REFERENCES creative_requests(id),
 ordinal integer NOT NULL, execution_status text NOT NULL DEFAULT 'queued', fence text, deadline_at timestamptz,
 submitted_at timestamptz, settled_at timestamptz, error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(request_id,ordinal)
);
CREATE TABLE provider_calls (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), attempt_id text NOT NULL UNIQUE REFERENCES generation_attempts(id),
 provider text NOT NULL DEFAULT 'openai', model text NOT NULL, endpoint text NOT NULL, status text NOT NULL DEFAULT 'intent',
 request_id text, usage jsonb, cost_usd numeric(18,8), cost_status text NOT NULL DEFAULT 'unknown',
 started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE generation_outputs (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), request_id text NOT NULL REFERENCES creative_requests(id),
 attempt_id text NOT NULL UNIQUE REFERENCES generation_attempts(id), asset_id text REFERENCES assets(id), asset_version_id text REFERENCES asset_versions(id),
 state text NOT NULL DEFAULT 'received', encoded_result text, staging_key text, sha256 text, bytes bigint,
 placement_status text NOT NULL DEFAULT 'pending', placement_reason text, document_ids jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE generation_inputs (
 workspace_id text NOT NULL REFERENCES workspaces(id), request_id text NOT NULL REFERENCES creative_requests(id),
 asset_id text NOT NULL REFERENCES assets(id), asset_version_id text NOT NULL REFERENCES asset_versions(id),
 PRIMARY KEY(request_id,asset_version_id)
);
CREATE TABLE quota_accounts (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id), quota_limit integer NOT NULL CHECK(quota_limit>0),
 reserved integer NOT NULL DEFAULT 0 CHECK(reserved>=0), used integer NOT NULL DEFAULT 0 CHECK(used>=0)
);
CREATE TABLE quota_reservations (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), attempt_id text NOT NULL UNIQUE REFERENCES generation_attempts(id),
 units integer NOT NULL CHECK(units>0), status text NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','consumed','released')),
 expires_at timestamptz NOT NULL, settled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE quota_ledger (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), reservation_id text NOT NULL REFERENCES quota_reservations(id),
 action text NOT NULL CHECK(action IN ('reserve','consume','release')), units integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(reservation_id,action)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['creative_requests','generation_attempts','provider_calls','generation_outputs','generation_inputs','quota_accounts','quota_reservations','quota_ledger'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY workspace_isolation ON %I USING (workspace_id = current_setting(''app.workspace_id'',true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'',true))',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO designx_tenant',t);
 END LOOP;
END $$;
