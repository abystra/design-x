CREATE TABLE creative_sessions (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id),
 project_id text NOT NULL REFERENCES projects(id), name text NOT NULL DEFAULT '默认创作会话',
 sandbox_id text, native_thread_id text, native_version text, scope_fingerprint text,
 boundary_reason text, active_attempt_id text, fence bigint NOT NULL DEFAULT 0,
 status text NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','running','paused','recovery_required','closed')),
 retained_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(project_id)
);
ALTER TABLE ai_turns ADD COLUMN session_id text REFERENCES creative_sessions(id);
ALTER TABLE ai_turns ADD COLUMN runtime_protocol text NOT NULL DEFAULT 'legacy';
ALTER TABLE ai_attempts ADD COLUMN event_cursor bigint NOT NULL DEFAULT 0;
ALTER TABLE ai_attempts ADD COLUMN fence bigint;
ALTER TABLE ai_attempts ADD COLUMN lease_owner text;
ALTER TABLE ai_attempts ADD COLUMN lease_until timestamptz;
ALTER TABLE ai_attempts ADD COLUMN outcome text;
CREATE TABLE creative_messages (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), session_id text NOT NULL REFERENCES creative_sessions(id),
 turn_id text REFERENCES ai_turns(id), role text NOT NULL CHECK(role IN ('user','assistant','tool','boundary')),
 content jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(turn_id,role)
);
CREATE INDEX creative_messages_session_idx ON creative_messages(session_id,created_at);
CREATE TABLE agent_runtime_events (
 workspace_id text NOT NULL REFERENCES workspaces(id), attempt_id text NOT NULL REFERENCES ai_attempts(id),
 sequence bigint NOT NULL, fence bigint NOT NULL, type text NOT NULL, payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(attempt_id,sequence)
);
CREATE TABLE agent_interactions (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), session_id text NOT NULL REFERENCES creative_sessions(id),
 turn_id text NOT NULL REFERENCES ai_turns(id), attempt_id text NOT NULL REFERENCES ai_attempts(id),
 native_request_id jsonb NOT NULL, questions jsonb NOT NULL, status text NOT NULL DEFAULT 'pending'
 CHECK(status IN ('pending','answered','expired','cancelled')), answers jsonb, created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz,
 UNIQUE(attempt_id,native_request_id)
);
CREATE TABLE agent_commands (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), turn_id text NOT NULL REFERENCES ai_turns(id),
 attempt_id text REFERENCES ai_attempts(id), interaction_id text REFERENCES agent_interactions(id),
 type text NOT NULL CHECK(type IN ('answer','stop')), payload jsonb NOT NULL, request_hash text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','applied','rejected','unknown')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_commands_pending_idx ON agent_commands(turn_id,status,created_at);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['creative_sessions','creative_messages','agent_runtime_events','agent_interactions','agent_commands'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY workspace_isolation ON %I USING (workspace_id = current_setting(''app.workspace_id'',true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'',true))',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO designx_tenant',t);
 END LOOP;
END $$;
