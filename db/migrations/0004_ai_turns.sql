CREATE TABLE ai_turns (
 id text PRIMARY KEY REFERENCES jobs(id), workspace_id text NOT NULL REFERENCES workspaces(id),
 project_id text NOT NULL REFERENCES projects(id), request jsonb NOT NULL, context jsonb NOT NULL,
 stage text NOT NULL DEFAULT 'queued', summary text NOT NULL DEFAULT '', proposals jsonb NOT NULL DEFAULT '[]',
 artboard_ids jsonb NOT NULL DEFAULT '[]', board_revision integer, applied_revision integer,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_turns_project_idx ON ai_turns(project_id,created_at DESC);
CREATE TABLE ai_attempts (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), turn_id text NOT NULL REFERENCES ai_turns(id),
 queue_id text NOT NULL, sandbox_id text, thread_id text, model text, usage jsonb,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','cleanup_failed','closed')),
 deadline_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_attempts_cleanup_idx ON ai_attempts(status,deadline_at);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['ai_turns','ai_attempts'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY workspace_isolation ON %I USING (workspace_id = current_setting(''app.workspace_id'',true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'',true))',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO designx_tenant',t);
 END LOOP;
END $$;
