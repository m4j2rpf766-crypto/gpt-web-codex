# Security model

GPT Web Codex treats the ChatGPT account, launcher browser profile, tunnel credential, MCP connector, workspace path, and local Codex executable as separate trust boundaries.

- Codex configuration and routing are outside the product's write scope.
- The launcher browser profile is private local data and is never packaged or logged.
- Tunnel keys are stored in private files and redacted from diagnostics.
- `codexluna_init` creates or restores a stable `web_session_id` and persists its explicit workspace, permission mode, model, reasoning, fast-mode, timeout, and session-policy version.
- Luna and terminal cancellation targets only the child process tree owned by the recorded job.
- File tools validate paths against the disclosed workspace unless full-control mode was selected.
- MCP tools return bounded structured output; long logs remain local.
- Luna image handoff accepts only existing supported image files and rechecks them through the job's recorded workspace and permission scope before returning bounded image data.
- Refreshable image cards keep only bounded compressed preview data and display metadata in the private standalone cache, never the source path. Entries expire after 90 days and the cache is capped at 128 previews.
- Browser control uses loopback-only owner tokens and process-bound descriptors.

MCP server instructions and the `codexluna_init` result tell ChatGPT that this conversation's context must not be actively written, updated, or migrated into cross-chat memory. Later Luna tool results repeat a compact policy marker. This is a tool-flow instruction, not control over ChatGPT account Memory settings.

Legacy product-named data directories may be migrated or retained as compatibility storage to preserve existing login and session state. Their names do not indicate an active Codex route.
