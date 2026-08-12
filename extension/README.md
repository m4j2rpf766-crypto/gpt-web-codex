# GPT Web Codex Chrome extension

This Manifest V3 extension replaces the launcher-owned ChatGPT browser surface. It uses the user's
normal Chrome profile and normal `chatgpt.com/c/<conversation-id>` conversations.

## Development install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `extension` directory.
4. Pin **GPT Web Codex** to the toolbar.
5. Open `https://chatgpt.com`, then use the extension's **New conversation** button.

Chrome displays a debugger notification briefly while the extension performs a trusted click or
keypress. This is expected; it disappears as soon as that single input operation finishes.

The `debugger` permission is used only for short, trusted pointer/keyboard input while selecting
Chat mode and submitting the two visible bootstrap messages. The extension detaches immediately
after each input operation. Existing conversations are never bootstrapped again.

Chrome **Developer mode** and the extension's `debugger` permission are separate:

- Loading this source directory unpacked requires Developer mode. A Chrome Web Store release can be
  installed normally without Developer mode.
- Full automatic Chat/Work switching currently requires the `debugger` permission so Chrome can
  deliver trusted input. A future no-debugger variant must either ask the user to select Chat
  manually or use a separately installed native input helper.

If an acknowledgement is already visible but ChatGPT's streaming control remains stuck, the
extension waits five seconds, stops that completed acknowledgement, and resumes. Reloading an
interrupted extension-owned `/c/` conversation resumes from its visible acknowledgement and saved
draft instead of replaying the memory-boundary message.

The standalone WebGPT Luna MCP runtime and OpenAI tunnel remain separate background components.
The extension does not modify Codex configuration or routing.
