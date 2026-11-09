CREATE TABLE provider_reconciliations (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), call_id text NOT NULL REFERENCES provider_calls(id),
 outcome text NOT NULL CHECK(outcome IN ('rejected','completed-unavailable')),
 cost_usd numeric(18,8) NOT NULL CHECK(cost_usd>=0), evidence text NOT NULL, actor text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE provider_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_reconciliations FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON provider_reconciliations USING(workspace_id=current_setting('app.workspace_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
GRANT SELECT,INSERT ON provider_reconciliations TO designx_tenant;
