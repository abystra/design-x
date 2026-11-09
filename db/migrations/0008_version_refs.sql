CREATE TABLE asset_version_refs (
 workspace_id text NOT NULL REFERENCES workspaces(id), version_id text NOT NULL REFERENCES asset_versions(id),
 document_id text NOT NULL REFERENCES documents(id), PRIMARY KEY(version_id,document_id)
);
ALTER TABLE asset_version_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_version_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON asset_version_refs USING(workspace_id=current_setting('app.workspace_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON asset_version_refs TO designx_tenant;
