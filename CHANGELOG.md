# Changelog

All notable changes to the **Agent Context Display** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-02-21

### Added

- TreeView sidebar with hierarchical display of session summary, main agent, and subagents.
- Status bar item showing hottest agent or session summary with risk-level icons.
- Webview detail panel with bar chart visualization sorted by context usage.
- Real-time JSONL log file monitoring via hybrid file watcher + polling.
- Incremental JSON Lines parsing with partial-line handling and deduplication.
- Configurable warning (default 70%) and critical (default 85%) context usage thresholds.
- One-shot desktop notifications when agents cross the critical threshold.
- Graceful handling of malformed lines, file truncation, and log rotation.
- JSON Schema (`schema/logSchema.v1.json`) for the v1 log format.
- Unit tests for parser, model, file poller, and state store.

[0.1.0]: https://github.com/ivarhuni/-vs-context/releases/tag/v0.1.0
