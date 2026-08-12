# Security model

GPT Web Codex treats the ChatGPT account, launcher browser profile, tunnel credential, MCP connector, workspace path, and local Codex executable as separate trust boundaries.

- Codex configuration and routing are outside the product's write scope.
- The launcher browser profile is private local data and is never packaged or logged.
- Tunnel keys are stored in private files and redacted from diagnostics.
- Every local tool request carries a stable `web_session_id`, explicit workspace path, and permission mode.
- Luna and terminal cancellation targets only the child process tree owned by the recorded job.
- File tools validate paths against the disclosed workspace unless full-control mode was selected.
- MCP tools return bounded structured output; long logs remain local.
- Browser control uses loopback-only owner tokens and process-bound descriptors.

The normal-chat bootstrap visibly tells ChatGPT that this conversation's context must not be used to update cross-chat memory. This is an instruction inside the conversation, not control over ChatGPT account Memory settings.

Legacy product-named data directories may be migrated or retained as compatibility storage to preserve existing login and session state. Their names do not indicate an active Codex route.
