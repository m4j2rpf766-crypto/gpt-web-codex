# GPT Web Codex

GPT Web Codex is a pure MCP launcher. A normal ChatGPT Web conversation is the planner; Luna executes and verifies local work through `codex exec --json` without changing Codex configuration or routing.

## What it does

- Uses ChatGPT in the user's normal browser; the launcher never embeds or automates ChatGPT.
- Binds each stable ChatGPT conversation URL to one persistent Luna session.
- Exposes asynchronous `codexluna_*` tools plus direct file and terminal tools over MCP.
- Serializes Luna work inside one web session while allowing different web sessions to run independently.
- Supports `read-only`, `workspace-write`, and `danger-full-access` execution modes.
- Keeps long-running jobs alive when the ChatGPT reply finishes; jobs can be polled or cancelled explicitly.
- Turns verified image artifacts from completed Luna jobs into native MCP image content and an inline preview instead of trusting a textual “displayed” claim.

## What it does not do

GPT Web Codex does **not** edit `~/.codex/config.toml`, install a model provider, replace the model catalog, proxy the Responses API, or take over Codex routes. You do not select a ChatGPT Web model inside Codex. ChatGPT Web plans; Luna executes locally.

## Runtime flow

```text
normal ChatGPT conversation
        │ MCP tool calls
        ▼
OpenAI Tunnel → standalone local MCP runtime
        │
        ├─ codexluna_init/start/status/cancel/session
        ├─ file_read (text + native MCP images + inline preview) / list / search / write
        └─ terminal_start/status/cancel
                 │
                 ▼
          codex exec --json (Luna)
```

## Development

Requirements: Windows, Codex CLI, a ChatGPT account with custom connectors, and an OpenAI Tunnel for MCP. The packaged launcher includes Bun.

```powershell
git clone https://github.com/miuuyy/codex-chatgpt-web.git
cd codex-chatgpt-web
bun install --frozen-lockfile
bun run launcher:dev
```

From the launcher:

1. Enter the Tunnel ID and a Tunnels Read + Use API key.
2. Create a ChatGPT connector named `WebGPT Luna Standalone`, using Tunnel transport and Authentication `None`.
3. Verify the runtime, then use the connector from a normal ChatGPT conversation in Chrome, Edge, Firefox, or another browser.

The connector name remains stable because ChatGPT caches tool contracts. Legacy local data directory names may be retained internally during migration so existing tunnel and Luna session state are not lost.

## Verification

```powershell
bun x tsc --noEmit
bun test tests
bun run launcher:typecheck
bun run launcher:test
```

## Security boundary

The launcher keeps tunnel credentials in private local storage and redacts them from logs. It does not keep ChatGPT cookies, browser profiles, or conversation history. `codexluna_init` returns the resolved workspace, permission mode, durable session ID, and a visible session-memory boundary before local execution. That boundary is prompt-level guidance; it cannot change the ChatGPT account's product-level Memory setting.

This is an independent, unofficial local MCP connector. It does not automate ChatGPT's UI and must not expose a tunnel or workspace you do not control.

## License

MIT. See [LICENSE](LICENSE) and [LICENSES](LICENSES).
