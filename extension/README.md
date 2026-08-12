# GPT Web Codex Chrome extension

This Manifest V3 extension replaces the launcher-owned ChatGPT browser surface. It uses the user's
normal Chrome profile and normal `chatgpt.com/c/<conversation-id>` conversations.

## Development install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `extension` directory.
4. Pin **GPT Web Codex** to the toolbar.
5. Open `https://chatgpt.com`, then use the extension's **New conversation** button.

This version does not request Chrome's `debugger` permission and never attaches a debugger to a
ChatGPT tab. Existing conversations are never bootstrapped again.

Chrome **Developer mode** is only an installation concern:

- Loading this source directory unpacked requires Developer mode. A Chrome Web Store release can be
  installed normally without Developer mode.
- The extension first attempts normal page controls. If ChatGPT rejects a synthetic Chat/Work
  switch or send action, it asks the user for that one click and resumes only after verifying the
  requested state.

If an acknowledgement is already visible but ChatGPT's streaming control remains stuck, the
extension waits five seconds, stops that completed acknowledgement, and resumes. Reloading an
interrupted extension-owned `/c/` conversation resumes from its visible acknowledgement and saved
draft instead of replaying the memory-boundary message.

The standalone WebGPT Luna MCP runtime and OpenAI tunnel remain separate background components.
The extension does not modify Codex configuration or routing.
