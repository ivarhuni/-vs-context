# Agent Context Display — VS Code Extension

Real-time visualization of agentic context/token usage from periodically read JSON logs, showing both main agent and subagent context consumption at a glance.

## Features

- **TreeView sidebar** — Hierarchical display of session summary, main agent, and subagents with token usage, risk levels, and status icons
- **Status bar** — At-a-glance hottest agent or session summary with risk-level icons
- **Webview panel** — Bar chart visualization of all agents sorted by context usage percentage
- **Real-time updates** — Hybrid file watcher + polling reads new JSONL entries incrementally
- **Threshold alerts** — Configurable warning (default 70%) and critical (default 85%) thresholds with one-shot notifications
- **Graceful error handling** — Malformed lines skipped, file truncation/rotation detected, missing file states shown

## Setup

1. Install the extension
2. Set `agentContext.logFilePath` in VS Code settings to point to your JSONL log file
3. The extension reads new entries automatically every 2 seconds (configurable)

## JSONL Log Format (v1)

Each line in the log file should be a JSON object following this schema:

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
          }
        }
      ]
    }
  ]
}
```

The full JSON Schema is at `schema/logSchema.v1.json`.

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `agentContext.logFilePath` | string | `""` | Absolute path to JSONL log file |
| `agentContext.pollIntervalMs` | number | `2000` | Polling interval in ms (1000-30000) |
| `agentContext.logLevel` | enum | `"info"` | Logging level: debug, info, warn, error |
| `agentContext.warningThresholdPercent` | number | `70` | Warning threshold for context usage |
| `agentContext.criticalThresholdPercent` | number | `85` | Critical threshold for context usage |
| `agentContext.notifyOnCritical` | boolean | `true` | Show notification on critical crossing |
| `agentContext.showStatusBar` | boolean | `true` | Show status bar item |
| `agentContext.statusBarMode` | enum | `"hottestAgent"` | Display mode: hottestAgent or sessionSummary |
| `agentContext.webview.retainContext` | boolean | `false` | Keep webview state when hidden |

## Commands

- **Agent Context: Show Tree** — Focus the TreeView sidebar
- **Agent Context: Open Detail Panel** — Open the webview bar chart panel
- **Agent Context: Refresh Now** — Trigger an immediate poll

## Development

```bash
npm install
npm run compile    # Build to out/
npm run lint       # ESLint
npm run test:unit  # Mocha unit tests
```

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
    ├── TreeView (session summary → agent hierarchy)
    ├── StatusBar (hottest agent / session summary)
    └── Webview (bar chart, sorted by usage)
```
