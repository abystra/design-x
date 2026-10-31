CREATE TABLE users (
 id text PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL, password_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workspaces (
 id text PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id), name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id)
);
CREATE TABLE sessions (
 token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
CREATE TABLE folders (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), name text NOT NULL,
 color text NOT NULL DEFAULT '#e6b49b', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,name)
);
CREATE TABLE projects (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), title text NOT NULL,
 type text NOT NULL DEFAULT '设计作品', image text, color text, folder_id text REFERENCES folders(id) ON DELETE SET NULL,
 primary_artboard_id text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 last_opened_at timestamptz, deleted_at timestamptz
);
CREATE INDEX projects_workspace_idx ON projects(workspace_id,updated_at DESC);
CREATE TABLE documents (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('board','artboard')), title text NOT NULL, content jsonb NOT NULL,
 revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX project_board_idx ON documents(project_id) WHERE kind='board';
CREATE TABLE document_versions (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), project_id text NOT NULL REFERENCES projects(id),
 document_id text NOT NULL REFERENCES documents(id), revision integer NOT NULL, name text, content jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX versions_document_idx ON document_versions(document_id,created_at DESC);
CREATE TABLE assets (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), title text NOT NULL,
 mime text NOT NULL, bytes bigint NOT NULL, width integer, height integer,
 object_key text NOT NULL, thumbnail_key text, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','failed')),
 error text, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE TABLE asset_refs (
 workspace_id text NOT NULL REFERENCES workspaces(id), asset_id text NOT NULL REFERENCES assets(id),
 document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE, PRIMARY KEY(asset_id,document_id)
);
CREATE TABLE preferences (
 workspace_id text NOT NULL REFERENCES workspaces(id), key text NOT NULL, value jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,key)
);
CREATE TABLE jobs (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), project_id text REFERENCES projects(id),
 kind text NOT NULL, status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
 progress integer NOT NULL DEFAULT 0, payload jsonb NOT NULL, result jsonb, error text,
 queue_id text, attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_workspace_idx ON jobs(workspace_id,created_at DESC);
CREATE TABLE events (
 id bigserial PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), type text NOT NULL,
 payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_workspace_idx ON events(workspace_id,id);
CREATE TABLE idempotency_keys (
 workspace_id text NOT NULL REFERENCES workspaces(id), key text NOT NULL, request_hash text NOT NULL,
 response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,key)
);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='designx_tenant') THEN CREATE ROLE designx_tenant NOLOGIN; END IF;
 EXECUTE format('GRANT designx_tenant TO %I', current_user);
END $$;
GRANT USAGE ON SCHEMA public TO designx_tenant;
GRANT USAGE,SELECT ON SEQUENCE events_id_seq TO designx_tenant;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['folders','projects','documents','document_versions','assets','asset_refs','preferences','jobs','events','idempotency_keys'] LOOP
   EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
   EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
   EXECUTE format('CREATE POLICY workspace_isolation ON %I USING (workspace_id = current_setting(''app.workspace_id'',true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'',true))',t);
   EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO designx_tenant',t);
 END LOOP;
END $$;
