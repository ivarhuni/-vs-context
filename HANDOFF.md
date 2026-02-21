# Handoff Notes

## Security Review (completed)

A full security code review was performed across the entire repo. Six issues were found and fixed (4 HIGH, 2 MEDIUM). All fixes are committed and pushed. Compile, lint, and all 49 unit tests pass.

### Issues Fixed

| # | Severity | File | Issue | Fix |
|---|----------|------|-------|-----|
| 1 | HIGH | `src/views/webviewPanel.ts` | `agent.riskLevel` injected directly into CSS class; `toLocaleString()`/`toFixed()` outputs unescaped in HTML. Crafted JSONL could inject arbitrary HTML. | All dynamic values routed through `esc()`; `riskLevel` validated against allowlist `['normal','warning','critical']`. |
| 2 | HIGH | `src/poller/filePoller.ts` | `Buffer.alloc(bytesToRead)` had no upper bound. Log file growing by GBs between polls would OOM-crash the extension host. | Reads capped at `MAX_CHUNK_BYTES` (10 MB); remaining data picked up on subsequent polls. |
| 3 | HIGH | `src/model/agentModel.ts` | `createAgent()` and `flattenAgents()` recurse into `children` without depth limit. Malicious deeply-nested agents could stack-overflow. | Both functions enforce `MAX_AGENT_DEPTH` (10). Webview's `flattenAndSort` also guarded. |
| 4 | HIGH | `src/parser/jsonlParser.ts`, `src/model/agentModel.ts` | Parser validated top-level fields but not individual agent objects. Missing `context` or non-numeric tokens produced `NaN` throughout UI. | Parser validates agent shape (`agentId` string + `context` object). `createAgent` uses `toFiniteNumber()` for numerics and `sanitizeStatus()`/role validation for enums. |
| 5 | MEDIUM | `src/parser/jsonlParser.ts` | `sessions` map grew without bound as new session IDs appeared. | Capped at `MAX_SESSIONS` (100) with oldest-first eviction. |
| 6 | MEDIUM | `src/views/webviewPanel.ts` | `esc()` did not escape single quotes. | Added `'` → `&#39;`. |

### Limits Introduced

All limits were reviewed for restrictiveness and are well-calibrated for real-world usage:

| Constant | Value | Location | Rationale |
|----------|-------|----------|-----------|
| `MAX_CHUNK_BYTES` | 10 MB | `filePoller.ts` | At 2s poll interval = 5 MB/s throughput (~20k+ lines/poll). Remaining data caught on next cycle. |
| `MAX_AGENT_DEPTH` | 10 | `agentModel.ts` | Real agent hierarchies are 3–4 levels deep. 10 is generous. |
| `MAX_SESSIONS` | 100 | `jsonlParser.ts` | UI only displays the latest session. 100 in-memory is generous. |
| `MAX_DEDUP_KEYS` | 10,000 | `jsonlParser.ts` | Pre-existing, not changed. Pruned to half when exceeded. |

### Things Already Done Well (no action taken)

- CSP on webview set to `default-src 'none'; style-src 'unsafe-inline'` with `enableScripts: false`.
- File watcher scoped to configured log file path/name only.
- Dedup key pruning already existed.
- File truncation/rotation detection correctly implemented.
- `localResourceRoots` properly scoped to `extensionUri`.

## Marketplace Publishing Blocker

The `publisher` field in `package.json` is set to `"agent-context"`. This must match a publisher registered at https://marketplace.visualstudio.com/manage. To publish:

1. Sign in with a Microsoft / Azure DevOps account.
2. Create a publisher with the exact ID used in `package.json` (or update `package.json` to match an existing one).
3. Generate a Personal Access Token with the **Marketplace (Manage)** scope.
4. Run `npx @vscode/vsce publish`.

Without this, `vsce publish` will fail. Local development (`F5`) works regardless.
