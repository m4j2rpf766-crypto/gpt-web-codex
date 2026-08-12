# GPT Web Codex requirements

This branch turns the upstream browser bridge into a standalone ChatGPT Web application backed by
local MCP tools and Codex Luna execution. These requirements are the source of truth for the
redesign.

## Non-negotiable boundaries

- Never modify Codex configuration or routing. Do not write `config.toml`, change
  `openai_base_url`, install a model provider/catalog, or require Codex Desktop to be running.
- ChatGPT Web is the planner. A selectable Codex Luna model executes and verifies delegated work.
- Use normal persistent ChatGPT conversations, not Temporary Chat.
- Never commit credentials, browser login state, cookies, tunnel keys, conversation bindings,
  command output, Codex JSONL, logs, caches, build output, or other runtime state.

## Tools

Expose both tool families by default:

1. High-level asynchronous Luna tools:
   - `codexluna_init`
   - `codexluna_start`
   - `codexluna_status`
   - `codexluna_continue`
   - `codexluna_cancel`
2. Direct tools for directory listing, file metadata/read/search/write, patch application, image
   viewing, and asynchronous terminal start/status/input/cancel.

ChatGPT may use direct tools for narrow operations and Luna for agentic execution. Work in one Luna
session is serialized. Separate Web conversations may run independently.

When a user asks to see a local image, a Luna message or filesystem path is not proof that the image
was rendered. The Luna job records verified absolute image artifacts, and `codexluna_status` returns
the first eligible artifact as native MCP image content plus inline preview metadata. ChatGPT may say
the image is displayed only when `image_preview_rendered` is true. Direct `file_image_preview` remains
available when ChatGPT already knows the path.

## Conversation and Luna session identity

- Do not require a browser extension or address-bar access to derive identity.
- On the first `codexluna_init` call in a ChatGPT conversation, generate a durable, opaque
  `web_session_id` unless the same conversation is explicitly restoring its existing id.
- Return the id as structured MCP output. ChatGPT must reuse it only inside the same conversation.
- Bind one Luna session to one Web conversation and persist the mapping across runtime restarts.
- Returning to the same ChatGPT conversation restores the prior Luna session when it remains
  resumable. Never automatically reuse one conversation's binding in another conversation.

## Session memory boundary

The MCP server exposes the boundary in its server instructions and returns the complete policy from
`codexluna_init`. Do not type bootstrap messages into the ChatGPT composer and do not require an ACK.

The returned policy must state that Web binding data, Luna context, task state, workspace details,
local execution records, summaries, preferences, paths, files, code, results, and inferred details
are scoped to the current `web_session_id`. ChatGPT must not actively write, update, merge, sync, or
migrate them into cross-conversation long-term memory, and must not reuse another conversation's
local binding.

Local persistence of the Luna session, task state, and necessary logs is allowed only to resume the
same Web conversation. Every later `codexluna_*` result repeats a compact policy marker so the
boundary survives long conversations and context compaction.

The initialization result must disclose that MCP cannot change or disable the ChatGPT account's
product-level Memory settings or directly control product-managed automatic memory behavior. Show
the resolved workspace, permission mode, and a concise boundary notice, then continue the authorized
task without asking for a confirmation token.

## Luna execution defaults

- Default model: Luna, with high reasoning and fast mode enabled. The model remains user-selectable.
- Launch Codex non-interactively with JSONL output and without loading the user's Codex
  configuration. Authentication may still come from the user's existing Codex login.
- Luna may analyze and adjust implementation details by default. If an attempt fails, return enough
  evidence for ChatGPT to issue a stricter follow-up instruction in the same Luna session.
- Retry a transient process or connection failure once. Never automatically repeat a task after it
  may have mutated the workspace.

## Paths, permissions, and network

- ChatGPT may request any absolute working path. Always show the requested path and effective access
  scope to the user; do not silently substitute a fixed workspace.
- Support read-only, workspace-write, and unrestricted full-control modes. Workspace-write remains
  the product default, while initial end-to-end development may run in full-control mode.
- Read-only requests disclose the path and proceed. Workspace-write confirms the first new writable
  scope. Full-control uses a one-time prominent disclosure rather than per-call confirmation.
- Workspace-write and full-control allow network access.
- Initial development prioritizes complete functionality. Stronger approval hardening follows after
  the full workflow operates end to end.

## Asynchronous jobs

- The default job timeout is 15 minutes and is user-adjustable.
- Stopping a ChatGPT answer does not cancel Luna.
- On timeout, request graceful cancellation, wait a short bounded grace period, then terminate only
  the owned child process tree. Preserve the Luna session id so a later call can resume it.
- Determine liveness from the owned process handle, terminal JSONL events, and persisted job state;
  never infer completion solely from elapsed time.
- Return compact progress, changed files, verification, and key errors to ChatGPT. Store full Codex
  JSONL and terminal output only in local runtime logs.

## Persistence and delivery

- Keep Web-to-Luna bindings separately from disposable logs. Clear a binding only at user request or
  after resume is proven impossible.
- Default local log retention is seven days and configurable. Never log credentials or browser
  session artifacts.
- Target Windows first. If a Windows platform limitation blocks core development, validate the
  affected layer on Linux without abandoning Windows as the primary target.
- Reuse the embedded ChatGPT browser when required by the launcher architecture.

## Git content policy

Commit source code, tests, documentation, schemas, migrations, deterministic fixtures, and packaging
logic required to build or understand the application. Do not commit generated packages, installed
dependencies, caches, local databases, profiles, logs, screenshots from private sessions, temporary
downloads, job state, session mappings, or credentials.
