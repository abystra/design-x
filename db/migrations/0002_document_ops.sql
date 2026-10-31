CREATE TABLE document_ops (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id),
 document_id text NOT NULL REFERENCES documents(id), revision integer NOT NULL,
 client_op_id text, ops jsonb NOT NULL, inverse_ops jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(document_id,revision), UNIQUE(document_id,client_op_id)
);
ALTER TABLE document_ops ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_ops FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON document_ops USING (workspace_id = current_setting('app.workspace_id',true)) WITH CHECK (workspace_id = current_setting('app.workspace_id',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON document_ops TO designx_tenant;
