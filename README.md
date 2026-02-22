# Agent Context Display

> Real-time visualization of agentic context and token usage in VS Code — monitor your main agent and subagents at a glance.

![VS Code](https://img.shields.io/badge/VS%20Code-%3E%3D1.85.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Version](https://img.shields.io/badge/version-0.1.0-orange)

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Quickstart](#quickstart)
- [Installation](#installation)
  - [Install from VSIX](#install-from-vsix)
  - [Build from Source](#build-from-source)
  - [Uninstall](#uninstall)
- [Configuration](#configuration)
- [JSONL Log Format](#jsonl-log-format)
- [Commands](#commands)
- [Architecture](#architecture)
- [Development](#development)
  - [Prerequisites](#prerequisites)
  - [Setup](#setup)
  - [Running Tests](#running-tests)
  - [Linting](#linting)
  - [Packaging](#packaging)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

When working with agentic AI systems (LLM orchestrators, multi-agent pipelines, tool-using agents), each agent consumes a finite context window. **Agent Context Display** reads a JSONL log file that your agent framework emits and surfaces the data directly inside VS Code:

- A **sidebar TreeView** shows session state and per-agent token consumption.
- A **status bar** item highlights the agent closest to its limit.
- A **webview panel** renders a sorted bar chart of all agents.
- **Desktop notifications** fire when any agent crosses a critical threshold.

This gives you instant visibility into context pressure across your entire agent hierarchy, without leaving your editor.

---

## Features

| Feature | Description |
|---|---|
| **TreeView sidebar** | Hierarchical display of the session summary, main agent, and subagents with token counts, risk levels, and status icons. |
| **Status bar** | Shows the hottest agent or a session summary with color-coded risk indicators. |
| **Webview detail panel** | Bar chart of all agents sorted by context usage percentage. |
| **Real-time updates** | Hybrid file-watcher + configurable polling reads new JSONL entries incrementally. |
| **Threshold alerts** | Configurable warning (default 70%) and critical (default 85%) thresholds with one-shot notifications. |
| **Graceful error handling** | Malformed lines are skipped, file truncation/rotation is detected, and missing-file states are shown. |

---

## Quickstart

Get up and running in under two minutes:

1. **Install the extension** from a `.vsix` package ([Install from VSIX](#install-from-vsix)) or [build from source](#build-from-source).

2. **Create a sample log file** to see the extension in action. Save the following as `~/agent-log.jsonl`:

   ```json
   {"v":1,"ts":"2026-02-21T10:00:00.000Z","sessionId":"demo-001","agents":[{"agentId":"main-1","role":"main","label":"Orchestrator","status":"running","context":{"usedTokens":90000,"maxTokens":128000,"breakdown":{"systemPrompt":2000,"userMessages":8000,"toolResults":70000,"fileContext":10000}},"children":[{"agentId":"sub-1","role":"subagent","parentAgentId":"main-1","label":"Researcher","status":"running","context":{"usedTokens":22000,"maxTokens":128000},"children":[]},{"agentId":"sub-2","role":"subagent","parentAgentId":"main-1","label":"Coder","status":"waiting","context":{"usedTokens":95000,"maxTokens":128000},"children":[]}]}]}
   ```

3. **Point the extension to your log file.** Open VS Code Settings (`Ctrl+,` / `Cmd+,`) and set:

   ```
   Agent Context > Log File Path  →  /home/you/agent-log.jsonl
   ```

   Or add to your `settings.json`:

   ```json
   {
     "agentContext.logFilePath": "/home/you/agent-log.jsonl"
   }
   ```

4. **Open the sidebar.** Click the pulse icon in the Activity Bar (or run the command *Agent Context: Show Tree*). You should see:

   - **Session summary** with agent counts and the hottest agent.
   - **Orchestrator** at ~70% usage (warning level).
   - **Coder** subagent at ~74% (warning level).
   - **Researcher** subagent at ~17% (normal level).

5. **Open the detail panel.** Run *Agent Context: Open Detail Panel* from the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) to see the bar chart visualization.

That's it — the extension will continue watching the log file and update every 2 seconds by default.

---

## Installation

This extension is not currently available in the VS Code Marketplace.

### Install from VSIX

If you have a `.vsix` package file, install it with:

```bash
code --install-extension agent-context-display-0.1.0.vsix
```

### Build from Source

```bash
# Clone the repository
git clone https://github.com/ivarhuni/-vs-context.git
cd -vs-context

# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Package into a .vsix file
npm run package

# Install the packaged extension
code --install-extension agent-context-display-0.1.0.vsix
```

#### Run in Extension Development Mode

For a faster feedback loop during development:

1. Open the project folder in VS Code.
2. Press `F5` to launch the Extension Development Host.
3. The extension activates automatically in the new window.

### Uninstall

To uninstall the extension from VS Code:

```bash
code --uninstall-extension agent-context.agent-context-display
```

Optional cleanup:

- Remove any `agentContext.*` settings from your `settings.json` if you no longer need them.
- Delete locally built `.vsix` files (for example, `agent-context-display-0.1.0.vsix`) if you no longer need the installer artifact.

---

## Configuration

All settings live under the `agentContext` namespace. Open VS Code Settings (`Ctrl+,` / `Cmd+,`) and search for *Agent Context*.

| Setting | Type | Default | Description |
|---|---|---|---|
| `agentContext.logFilePath` | `string` | `""` | Absolute path to the JSONL log file your agent framework writes. |
| `agentContext.pollIntervalMs` | `number` | `2000` | How often (in ms) the extension polls for new log entries. Range: 1 000–30 000. |
| `agentContext.logLevel` | `enum` | `"info"` | Extension log verbosity: `debug`, `info`, `warn`, `error`. |
| `agentContext.warningThresholdPercent` | `number` | `70` | Context usage % that triggers the **warning** state (yellow). |
| `agentContext.criticalThresholdPercent` | `number` | `85` | Context usage % that triggers the **critical** state (red). |
| `agentContext.notifyOnCritical` | `boolean` | `true` | Show a desktop notification the first time an agent crosses the critical threshold. |
| `agentContext.showStatusBar` | `boolean` | `true` | Show the status bar item. |
| `agentContext.statusBarMode` | `enum` | `"hottestAgent"` | Status bar display mode: `hottestAgent` (single agent closest to limit) or `sessionSummary` (aggregate counts). |
| `agentContext.webview.retainContext` | `boolean` | `false` | Keep webview state in memory when the panel is hidden. Uses more memory but preserves scroll position. |

---

## JSONL Log Format

The extension reads a [JSON Lines](https://jsonlines.org/) file where each line is a self-contained JSON object conforming to the **v1** schema. A full JSON Schema is provided at `schema/logSchema.v1.json`.

### Minimal Example

```json
{"v":1,"ts":"2026-02-21T14:30:00.000Z","sessionId":"abc-123","agents":[{"agentId":"main-1","role":"main","label":"Orchestrator","status":"running","context":{"usedTokens":45000,"maxTokens":128000},"children":[]}]}
```

### Full Example (with breakdown and subagents)

```json
{
  "v": 1,
  "ts": "2026-02-21T14:30:00.000Z",
  "sessionId": "abc-123",
  "agents": [
    {
      "agentId": "main-1",
      "role": "main",
      "label": "Orchestrator",
      "status": "running",
      "context": {
        "usedTokens": 45000,
        "maxTokens": 128000,
        "breakdown": {
          "systemPrompt": 2000,
          "userMessages": 8000,
          "toolResults": 30000,
          "fileContext": 5000
        }
      },
      "children": [
        {
          "agentId": "sub-1",
          "role": "subagent",
          "parentAgentId": "main-1",
          "label": "Researcher",
          "status": "done",
          "context": {
            "usedTokens": 22000,
            "maxTokens": 128000
          },
          "children": []
        }
      ]
    }
  ]
}
```

### Field Reference

| Field | Type | Required | Description |
|---|---|---|---|
| `v` | `integer` | Yes | Schema version, must be `1`. |
| `ts` | `string` (ISO 8601) | Yes | Timestamp of this snapshot. |
| `sessionId` | `string` | Yes | Unique identifier for the agent session. |
| `agents` | `array` | Yes | Top-level agents (at least one). |
| `agents[].agentId` | `string` | Yes | Unique agent identifier. |
| `agents[].role` | `"main"` or `"subagent"` | Yes | Agent role in the hierarchy. |
| `agents[].label` | `string` | Yes | Human-readable agent name. |
| `agents[].status` | `"running"`, `"waiting"`, `"done"`, `"error"` | Yes | Current agent status. |
| `agents[].context.usedTokens` | `number` | Yes | Tokens consumed so far. |
| `agents[].context.maxTokens` | `number` | Yes | Maximum context window size. |
| `agents[].context.breakdown` | `object` | No | Optional breakdown by category. |
| `agents[].children` | `array` | No | Nested subagents (recursive). |

---

## Commands

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and type *Agent Context* to see all available commands:

| Command | Description |
|---|---|
| **Agent Context: Show Tree** | Focus the TreeView sidebar panel. |
| **Agent Context: Open Detail Panel** | Open the webview bar chart in a secondary editor column. |
| **Agent Context: Refresh Now** | Trigger an immediate poll of the log file (no need to wait for the next interval). |

---

## Architecture

```
Log File (JSONL)
    │
    ▼
FilePoller (hybrid watcher + interval, async I/O)
    │
    ▼
JsonlParser (incremental, partial-line safe, dedup)
    │
    ▼
StateStore (change detection, event emission)
    │
    ├── AgentTreeProvider → TreeView sidebar
    ├── StatusBarManager  → Status bar item
    └── WebviewPanel      → Bar chart detail panel
```

**Key design decisions:**

- **Incremental parsing** — only new bytes appended to the log file are read on each poll, making it efficient even with large log files.
- **File rotation detection** — if the file shrinks (truncation) or is replaced, the parser resets automatically.
- **No external runtime dependencies** — the extension ships as a self-contained `.vsix` with zero npm production dependencies.

---

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) 18+ and npm 9+
- [VS Code](https://code.visualstudio.com/) 1.85.0 or later
- Git

### Setup

```bash
git clone https://github.com/ivarhuni/-vs-context.git
cd -vs-context
npm install
npm run compile
```

### Running in Development Mode

1. Open the project in VS Code.
2. Press `F5` to launch the **Extension Development Host**.
3. Set `agentContext.logFilePath` in the dev host's settings to a JSONL file.
4. The extension activates on startup and begins monitoring.

### Running Tests

```bash
# Unit tests (Mocha + ts-node, no VS Code instance required)
npm run test:unit

# Integration tests (launches VS Code test runner)
npm test
```

### Linting

```bash
npm run lint
```

### Packaging

```bash
# Produces agent-context-display-0.1.0.vsix
npm run package
```

---

## Contributing

Contributions are welcome! Please:

1. Fork the repository.
2. Create a feature branch (`git checkout -b feature/my-feature`).
3. Run `npm run lint` and `npm run test:unit` before committing.
4. Open a Pull Request with a clear description.

---

## License

This project is licensed under the [MIT License](LICENSE).
