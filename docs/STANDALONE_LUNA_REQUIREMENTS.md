# Standalone WebGPT + Luna requirements

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
   - `codexluna_start`
   - `codexluna_status`
   - `codexluna_continue`
   - `codexluna_cancel`
2. Direct tools for directory listing, file metadata/read/search/write, patch application, image
   viewing, and asynchronous terminal start/status/input/cancel.

ChatGPT may use direct tools for narrow operations and Luna for agentic execution. Work in one Luna
session is serialized. Separate Web conversations may run independently.

## Conversation and Luna session identity

- Derive the durable Web session identity from the stable normal-chat URL, normally its
  `/c/<conversation-id>` component; a browser tab id is not a durable identity.
- Bind one Luna session to one Web conversation and persist the mapping across launcher restarts.
- Returning to the same ChatGPT conversation restores the prior Luna session when it remains
  resumable.
- Before the URL receives a stable conversation id, use a provisional local identity and migrate it
  atomically after navigation exposes the stable id.

## Session memory boundary

Before enabling tools in a new conversation, show a visible local notice and automatically send a
visible bootstrap message to ChatGPT. Keep the message and acknowledgement in the chat.

Bootstrap message:

> 会话上下文边界声明：
>
> 本对话是一个独立、会话级的工作空间。本对话中出现的所有内容，包括用户信息、偏好、路径、文件内容、代码、工具调用、Luna 执行结果、项目决策和工作习惯，仅可用于理解和完成本对话内的任务。
>
> 不要主动将这些内容保存、更新、推断或推荐保存为任何跨对话、长期或账户级记忆；不要在其他对话中引用或延续这些内容。已有的跨对话记忆不得覆盖本对话中的明确指令，与当前任务无关的既有记忆也不要主动引入。
>
> 此边界同样适用于后续所有 MCP 工具结果和 Luna session 内容，直到用户在本对话中明确撤销为止。
>
> 如果账户或产品存在你无法直接控制的自动记忆机制，不要声称它已被本提示关闭。本声明是对本次对话行为的约束，不代表修改了用户的 ChatGPT 账户设置。
>
> 请仅回复：`SESSION_MEMORY_BOUNDARY_ACK`

The launcher must disclose that this prompt does not change account-level ChatGPT Memory settings.
Tools remain disabled until the acknowledgement is observed.

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
