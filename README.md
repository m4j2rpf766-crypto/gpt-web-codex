# GPT Web Codex

GPT Web Codex turns a normal ChatGPT Web conversation into the planner for local work. ChatGPT can call a standalone MCP connector; Luna executes and verifies the requested work through `codex exec --json` without changing Codex configuration or routing.

## What it does

- Opens normal, persistent ChatGPT conversations in a launcher-owned browser profile.
- Binds each stable ChatGPT conversation URL to one persistent Luna session.
- Exposes asynchronous `codexluna_*` tools plus direct file and terminal tools over MCP.
- Serializes Luna work inside one web session while allowing different web sessions to run independently.
- Supports `read-only`, `workspace-write`, and `danger-full-access` execution modes.
- Keeps long-running jobs alive when the ChatGPT reply finishes; jobs can be polled or cancelled explicitly.

## What it does not do

GPT Web Codex does **not** edit `~/.codex/config.toml`, install a model provider, replace the model catalog, proxy the Responses API, or take over Codex routes. You do not select a ChatGPT Web model inside Codex. ChatGPT Web plans; Luna executes locally.

## Runtime flow

```text
normal ChatGPT conversation
        │ MCP tool calls
        ▼
OpenAI Tunnel → standalone local MCP runtime
        │
        ├─ codexluna_start/status/cancel/session
        ├─ file_read/list/search/write
        └─ terminal_start/status/cancel
                 │
                 ▼
          codex exec --json (Luna)
```

## Development

Requirements: Windows, Bun 1.3.14, a signed-in ChatGPT account, Codex CLI, and an OpenAI Tunnel for MCP.

```powershell
git clone https://github.com/miuuyy/codex-chatgpt-web.git
cd codex-chatgpt-web
bun install --frozen-lockfile
bun run launcher:dev
```

From the launcher:

1. Sign in to ChatGPT and run the browser smoke test.
2. Prepare the standalone runtime.
3. Enter the Tunnel ID and a Tunnels Read + Use API key.
4. Create a ChatGPT connector named `WebGPT Luna Standalone`, using Tunnel transport, Authentication `None`, and Allow all actions.
5. Verify the runtime, then open a normal ChatGPT conversation.

The connector name remains stable because ChatGPT caches tool contracts. The application displays the new product name `GPT Web Codex`; legacy local data directory names may be retained internally during migration so existing login, tunnel, and Luna session state are not lost.

## Verification

```powershell
bun x tsc --noEmit
bun test tests
bun run launcher:typecheck
bun run launcher:test
```

## Security boundary

The launcher keeps ChatGPT browser state and tunnel credentials in private local storage and redacts them from logs. Workspace and permission mode are disclosed before local execution. The visible session-memory notice is prompt-level guidance; it cannot change the ChatGPT account's product-level Memory setting.

This is independent, unofficial browser automation. It can break when ChatGPT's UI changes and must not be used to evade usage limits or access controls.

## License

MIT. See [LICENSE](LICENSE) and [LICENSES](LICENSES).
