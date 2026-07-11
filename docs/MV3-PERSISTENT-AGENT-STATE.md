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

### 2. Durable Checkpointing, Split by Payload Size

Small, hot job state (plan, phase, logs, flags) lives in `chrome.storage.local` — synchronous-ish, survives worker death, cheap to update every step. Bulk payloads (scraped pages) go to a dedicated IndexedDB (`ResearchJobCacheDB`) keyed by URL, so a resumed run replays pages from disk instead of the network.

### 3. Heartbeats as Liveness Signals

While a job runs, the service worker updates a `lastHeartbeatAt` timestamp on the job record every 20 seconds (the same interval doubles as the MV3 keep-alive: any extension API call resets the ~30 s idle timer). A later worker instance reads this to distinguish "run died" from "run is still going in another instance".

### 4. Resume Gates to Prevent Duplicate Work

Before resuming a job at startup, require ALL of: job marked `active`, heartbeat **stale** (>3 min — a fresh heartbeat means a completed run's cleanup write lost a race with worker death, so skip), job age under 12 h, and fewer than 3 prior resume attempts (then fail loudly into the chat instead of looping).

### 5. Worker Startup as the Waker

A dead worker can't wake itself — but Chrome starts a fresh instance on the next event (a message, an alarm, browser launch). The resume check runs once per worker instance at startup; a periodic `chrome.alarms` job (the 5-minute sync alarm) guarantees such an event eventually arrives even if the user never touches the extension.

## The 5-Minute Resume Loop War Story

A critical bug occurs if the heartbeat check is absent or mismanaged: the service worker thinks a job is active and starts resuming it repeatedly while the offscreen document is still working. This manifests as:

- Research jobs resuming endlessly every few minutes
- Double execution of agents
- Confusing duplicate progress logs

We fixed this by adding:

- An explicit `lastHeartbeatAt` timestamp updated every 20 seconds while the run executes
- A staleness threshold `HEARTBEAT_STALE_MS = 3 * 60 * 1000` (3 minutes)
- An explicit `active: false` state written upon job completion (before the checkpoint is cleared, so losing the clear-write race can't cause a spurious resume)
- A resume-attempt counter capped at 3, after which the job fails loudly into the chat
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
