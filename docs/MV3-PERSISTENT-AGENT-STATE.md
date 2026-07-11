# How to Run a Multi-Minute Agent in a Manifest V3 Extension That Wants to Die Every 30 Seconds

## Introduction

Developing long-running agents in Chrome Manifest V3 extensions is challenging due to the ephemeral nature of service workers that die after short idle periods. This article documents a robust pattern to achieve persistence and continuity for agents that perform long-running tasks such as deep research, web scraping, or language model orchestration.

## The Problem

Service workers in MV3 are not persistent — they can be stopped and restarted by the browser at any time, generally after ~30s of inactivity. This unpredictability conflicts with agents that require minutes of continuous execution:

- Multi-agent research workflows that batch dozens of web scrapes and LLM calls
- Continuous data ingestion and real-time log streaming
- Timeout-prone calls to external APIs, long async pipelines

Without careful state management and recovery, these agents risk data loss, duplicate execution, or stalled progress.

## The Pattern: Five Pillars of Persistence

The solution combines five interlocking components:

### 1. Offscreen Document for Long-Lived Compute

MV3 extensions can create an "offscreen document" — an invisible, persistent web page instance that lives outside the ephemeral service worker lifecycle. Use it to run compute-intensive and long-lived JS code, including transformer models, OCR, and event loops.

### 2. IndexedDB for Crash-Consistent Checkpointing

Maintain your agent's working state in IndexedDB so it survives service worker termination. Incrementally checkpoint scraped pages, partial research logs, and job state.

### 3. Heartbeats as Liveness Signals

The offscreen document periodically writes a heartbeat timestamp to IndexedDB. The service worker reads this to infer if the long-running job is alive or stuck.

### 4. Resume Gates to Prevent Duplicate Work

Before starting or resuming a job, check for a recent heartbeat. If the timestamp is still fresh (e.g., less than 3 minutes old), avoid starting duplicate parallel jobs.

### 5. Chrome Alarms as a Waker

The Chrome alarms API schedules periodic wake-ups for the service worker, allowing it to check and resume jobs after being suspended.

## The 5-Minute Resume Loop War Story

A critical bug occurs if the heartbeat check is absent or mismanaged: the service worker thinks a job is active and starts resuming it repeatedly while the offscreen document is still working. This manifests as:

- Research jobs resuming endlessly every few minutes
- Double execution of agents
- Confusing duplicate progress logs

We fixed this by adding:

- An explicit `lastHeartbeatAt` timestamp updated every minute
- A staleness threshold `HEARTBEAT_STALE_MS = 3 * 60 * 1000` (3 minutes)
- An explicit `active: false` state written upon job successful completion
- Service worker checks these signals before launching or resuming jobs

## Code Highlights

See:

- `research-store.ts`: defines job state, heartbeats, and staleness check
- `service-worker.ts`: resume logic and alarms handling

## When to Use This Pattern

Recommended for agents that:

- Run longer than 30 seconds
- Perform network I/O or await LLM calls
- Require exactly-once or at-least-once guarantees

Avoid for:

- Short-lived tasks
- Stateless or idempotent functions

## Alternatives and Limitations

- Background pages (MV2) offered persistent workers but are deprecated
- Alarms alone lack context; offscreen allows full JS runtime
- This pattern adds complexity but is stable

## Conclusion

The MV3 persistent agent pattern enables robust, long-running research agents that survive typical browser lifecycle disruptions. By combining offscreen computing, IndexedDB checkpointing, heartbeats, and alarms, your extension can provide seamless user experiences even under stringent MV3 constraints.

---

*This document is published under the Apache 2.0 license. Contributions welcome.*
