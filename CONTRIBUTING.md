# Contributing

Keep the product focused on normal ChatGPT Web planning with standalone Luna execution.

Core invariants:

- Never modify Codex configuration, providers, model catalogs, or routing.
- Bind sessions by stable ChatGPT conversation URL, not by tab identity.
- Serialize Luna jobs within one web session and persist the Luna session binding.
- Expose high-level Luna tools and direct file/terminal tools by default.
- Never commit browser state, API keys, tunnel IDs, Luna JSONL, command output, logs, or absolute user paths.
- Keep connector tool contracts stable and fail closed on incomplete browser or runtime evidence.

Before opening a pull request, run root typechecking/tests plus launcher typechecking/tests. Browser UI changes should include exact observed DOM evidence and a focused fixture. Native packages must be built on their matching operating system.
