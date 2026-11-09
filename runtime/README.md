# Design X sandbox execution components

Business APIs, authorization, generation, quotas and storage remain TypeScript services. This directory contains only the E2B Python supervisor and the Go read-only material filesystem.

The vendored source is pinned to WorkX `f81c31a3b09d13d8955248ec7bdefbdfc1f08a6e`; `provenance.json` records original and ported hashes. WorkX's original Codex `0.144.0` verification does not certify this target. The target is Codex app-server `0.166.0`. Its schema requires dynamic tools with `type: function` and native names without dots; the adapter maps `assets_list` back to the trusted `assets.list` service. Native questions in Default mode require the explicit, version-bound `default_mode_request_user_input` flag.

```sh
python runtime/verify-provenance.py
python -m pip install -e 'runtime/runner[test]'
python -m pytest runtime/runner/tests -q
python runtime/matfs/build.py
node --import tsx infra/e2b/build.ts
node --import tsx infra/e2b/verify.ts
```

After the independent Design X R2 buckets and credentials are authorized, run the material acceptance against a disposable fixture:

```sh
node --env-file=.env.r2.local --import tsx scripts/verify-r2-runtime.ts --live --keep --browser
node --import tsx infra/e2b/verify-materials.ts --live
node --import tsx scripts/verify-agent-workflow.ts --live --fixture artifacts/v2/r2-acceptance.json
node --env-file=.env.r2.local --import tsx scripts/verify-r2-runtime.ts --cleanup <fixture-workspace-id>
```

The user-authorized local `designx` profile uses one bucket with separate paths. Add `--single-bucket-test` to the three verification commands for that profile; it is rejected in production. See [local R2 setup](../infra/r2/README.md). Browser verification requires the local Web origin to be running. The workflow verifier additionally exercises authenticated submission, the real business Worker, atomic document/Board/version references, and a real PNG export; it does not issue an image-generation request.

The material verifier accepts only a retained successful fixture report. It tests the mounted manifest, two project credential scopes, unlisted pool objects, same-size content tampering, read-only behavior, credential expiry, byte budgets and fail-closed mounting. Its final real Agent run must open the fresh mount and return a version-pinned image layer plus a text layer containing the independently verified file digest. The script checks the root-only verified cache, writes the artifact and acceptance metadata under `artifacts/v2`, and removes its VMs and additional object fixtures in `finally`. The original disposable workspace remains available until the explicit fixture cleanup command.

The build command snapshots an allowlist of source files into a temporary context. Environment files are never copied. It records the immutable `templateId:buildId`, each source digest, validator digest and Linux binary digest in `infra/e2b/dist/build.json`. CI builds candidates on manual dispatch; it does not enable a runtime or deploy the platform. The cloud verifier makes bounded real DeepSeek calls and destroys its sandboxes.

`DESIGNX_RUNNER_V2=true` affects newly submitted turns only. `DESIGNX_E2B_TEMPLATE` must be an immutable build reference. Old turns retain their recorded runtime protocol. Business history is persisted in PostgreSQL; native checkpoints are optional version-bound acceleration. A rejected checkpoint records an explicit boundary before starting fresh. Unresolved native activity is never resubmitted automatically.

The root-owned Runner journal has monotonically increasing sequence numbers and an attempt/fence identity. Observer disconnects reattach the same VM and replay that journal. Tool side effects use trusted database idempotency keys; replay does not submit a second generation. A separate root command queue handles native answers and interruption while a native request is pending. Thirty-second observer leases prevent a superseded observer from committing, cancelling the replacement or changing the business job's result.

Successful sessions pause and retain their VM for at most 24 hours. Each new turn reauthorizes project material versions, renews temporary credentials, clears old unprivileged processes and prepares a new mount before starting Codex. Changed authorization resets the native context and retires the old VM. The Runner and material credential processes run as root; Codex runs under the unprivileged `user` account, with privilege escalation executables restricted. Agent-writable directories sit beneath root-owned `/workspaces/designx` parents. Material credentials never enter Codex's environment.

`matfs` sees only the trusted project manifest and verifies size/SHA-256 on opening each file. Its temporary R2 credential covers a project content pool, not individual manifest entries; exact visibility is enforced by the mount. A failed mount prevents execution. Outputs pass through the separate root output journal and the platform's schema/source/fence checks before any document mutation.

The read budget counts bytes fetched even when integrity verification fails. Each uncached read reserves the declared size plus one verification byte, then releases only bytes that were not transferred. Repeated reads of a tampered object therefore cannot receive unlimited free retries. Cached verified reads require no additional R2 transfer budget.

Real cloud acceptance evidence is kept separately from fixture tests. Empty-project native execution does not certify R2 mounting. Production requires independent Design X buckets, data and authorization. For local acceptance, the user may explicitly authorize reusing credential values from `.env.r2-test.local`; map them to the ignored, mode-0600 `.env.r2.local` profile without importing WorkX business paths or data. The default targets remain `designx-v2-assets` and `designx-v2-staging`. If the user explicitly selects existing buckets for temporary verification, fixtures stay beneath a disposable workspace prefix and the verifiers never create cloud buckets or replace global CORS/policies. Configure the required browser origin separately; verification checks its actual OPTIONS preflight without requiring bucket-management permissions. Retained fixtures are bound to their storage profile and cannot be reused with a different target.
