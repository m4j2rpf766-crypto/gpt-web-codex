# GPT Web Codex

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/m4j2rpf766-crypto/gpt-web-codex/actions/workflows/ci.yml/badge.svg)](https://github.com/m4j2rpf766-crypto/gpt-web-codex/actions/workflows/ci.yml)

GPT Web Codex 是一个纯 MCP 启动器。普通 ChatGPT 网页对话负责规划，Luna 通过 `codex exec --json` 在本机执行并验证任务。

## 主要功能

- 在用户自己的普通浏览器中使用 ChatGPT；启动器不内嵌或自动控制 ChatGPT。
- 将每个稳定的 ChatGPT 网页对话绑定到一个持久化 Luna 会话。
- 通过 MCP 同时提供异步 `codexluna_*` 工具以及直接文件、终端工具。
- 同一网页会话中的 Luna 任务串行执行，不同网页会话可以独立运行。
- 支持 `read-only`、`workspace-write` 和 `danger-full-access` 三种权限模式。
- ChatGPT 停止回答后，长任务仍可继续执行；网页端可以查询状态或主动取消。
- 可将 Luna 生成并验证的图片作为原生 MCP 图片返回，并在网页对话中显示预览。
- 大图片会生成压缩预览副本，结构化工具结果不会在文本内容中重复传输。

## 不会做什么

GPT Web Codex 不会编辑 `~/.codex/config.toml`、安装模型提供方、替换模型目录、代理 Responses API，也不会接管 Codex 路由。ChatGPT 网页负责规划，Luna 在本机负责执行。

## 运行流程

```text
普通 ChatGPT 网页对话
        │ MCP 工具调用
        ▼
OpenAI Tunnel → 本机独立 MCP 运行时
        │
        ├─ codexluna_init/start/status/cancel/session
        ├─ file_read / file_image_preview / file_list / file_search / file_write
        └─ terminal_start/status/cancel
                 │
                 ▼
          codex exec --json（Luna）
```

## 本地开发

当前需要 Windows、Codex CLI、支持自定义连接器的 ChatGPT 账户，以及用于 MCP 的 OpenAI Tunnel。安装包已经内置 Bun；从源码构建需要 Bun 1.3.14。

```powershell
git clone https://github.com/m4j2rpf766-crypto/gpt-web-codex.git
cd gpt-web-codex
bun install --frozen-lockfile
bun run launcher:dev
```

在启动器中：

1. 填写 Tunnel ID 和具有 Tunnels Read + Use 权限的 API Key。
2. 在 ChatGPT 中创建名为 `WebGPT Luna Standalone` 的连接器，连接方式选择隧道，身份验证选择无。
3. 验证运行时，然后在 Chrome、Edge、Firefox 等普通浏览器的 ChatGPT 对话中启用该连接器。

连接器名称保持稳定，因为 ChatGPT 会缓存工具契约。迁移期间可能继续使用旧的本机数据目录名称，以保留现有隧道凭据和 Luna 会话绑定。

## 验证

```powershell
bun x tsc --noEmit
bun test tests
bun run launcher:typecheck
bun run launcher:test
```

## 安全边界

启动器将隧道凭据保存在本机私有目录，并在日志中进行脱敏。它不会保存 ChatGPT Cookie、浏览器配置或网页对话历史。`codexluna_init` 会在本地执行前返回实际工作区、权限模式、持久化会话 ID 和会话记忆边界。

会话边界属于提示词级约束，无法修改 ChatGPT 账户自身的“记忆”产品设置。本项目是独立、非官方的本地 MCP 连接器；不要公开暴露不受你控制的隧道或工作区。

## 许可证

MIT。参见 [LICENSE](LICENSE) 和 [LICENSES](LICENSES)。

## 致谢

GPT Web Codex 基于原项目 [miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web) 演进而来。衷心感谢 miuuyy 以及原项目的所有贡献者，是他们的工作让本项目成为可能。
