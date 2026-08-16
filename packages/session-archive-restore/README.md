# @dsh-plugins/session-archive-restore

Adds local hot endpoints for restoring and permanently deleting archived DSH
sessions. Restore keeps the workspace slot; deletion removes the workspace
reference, projection-cache row, and JSONL session artifact.

Endpoints:

- `GET /api/dsh-launcher/archive-sessions`
- `POST /api/dsh-launcher/archive-sessions/restore` with `{"sessionId":"..."}`
- `POST /api/dsh-launcher/archive-sessions/delete` with `{"sessionId":"..."}`
- `POST /api/dsh-launcher/archive-sessions/delete-all`

Only loopback requests are accepted. Install it into a profile with:

```sh
dsh plugin --profile web add file:/absolute/path/to/dsh-plugins/packages/session-archive-restore
```

## Config

This plugin has no user-configurable fields. It uses the injected DSH
`webServer`, `storageDomain`, `sessions`, `sessionPersistence`, and
`workspaceRegistry` services.

## Model Experience

This plugin does not participate in model inference, prompts, or KV-cache. It
only exposes the local management seam consumed by dsh-launcher.

## Known Limitations and Deferred Work

Export is intentionally out of scope. Running sessions and non-JSONL storage
backends cannot be permanently deleted.
