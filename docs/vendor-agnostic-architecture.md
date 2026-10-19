# Vendor-agnostic architecture

## Overview

```
                    ┌──────────────┐
                    │   Browser    │  input + rendering + interpolation
                    └──────┬───────┘
                           │ HTTPS / WSS (single origin)
                    ┌──────▼───────┐
                    │  Edge cache / │──── static assets (cached, long TTL)
                    │  CDN          │──── short-TTL cached leaderboard API
                    └──┬─────────┬─┘
            static     │         │  realtime + API (not cached)
              ┌────────▼──┐   ┌──▼──────────────┐
              │  Object   │   │  Load balancer  │  (only reachable from the CDN)
              │  storage  │   └──┬───────────┬──┘
              └───────────┘      │ WS upgrade │ /api
                    ┌────────────▼───┐   ┌───▼──────────────┐
                    │ Container pool │   │ Function: read   │
                    │ (autoscaled)   │   │ leaderboard API  │
                    │ worker = 1     │   └───┬──────────────┘
                    │ authoritative  │       │
                    │ world          │       │
                    └───────┬────────┘       │
                            │ domain events  │
                    ┌───────▼────────┐       │
                    │ Message queue  │──DLQ  │
                    └───────┬────────┘       │
                    ┌───────▼────────┐       │
                    │ Async worker   │       │
                    │ (function)     │       │
                    └───────┬────────┘       │
                    ┌───────▼────────────────▼──┐
                    │ Structured key-value store │ players, results, leaderboard index
                    └────────────────────────────┘
      Monitoring system: logs, metrics, alarms, dashboards from every component
```

## Components

| Concept | Responsibility | Why it is needed |
|---------|----------------|------------------|
| **Edge cache / CDN** | Terminates TLS near users. Caches fingerprinted static assets (immutable, 1-year TTL) and the leaderboard API (10 s TTL). Forwards WebSocket upgrades. | Static delivery scales independently of game servers. Repeat asset requests never reach the origin. One origin for page, API and WebSocket means no CORS and a single TLS certificate. |
| **Object storage** | Holds the built frontend (HTML, JS, PNG). Private, readable only by the CDN. | Durable and cheap. No servers are needed to serve static content. |
| **Load balancer** | Accepts WebSocket upgrades and API calls from the CDN and spreads *new* connections across healthy game workers. Health-checks workers. | Dispatcher-push load distribution. Hides individual workers. Unhealthy workers stop receiving traffic. |
| **Containerised game workers** | Each worker process owns **exactly one authoritative world**: lobby, 50 snake slots, food, collision, scoring, 30 Hz tick, 15 Hz snapshots. | Realtime simulation needs long-lived in-memory state and a steady CPU budget. That is a poor fit for short-lived functions and a good fit for containers. |
| **Horizontal autoscaler** | Adjusts the number of workers (= worlds) from measured load: world occupancy and CPU. Protects workers hosting active players from scale-in. | Capacity follows demand. Idle capacity is released. |
| **Message queue (+ dead-letter queue)** | Durable buffer for domain events (`PLAYER_DIED`, `SESSION_ENDED`, `WORLD_STARTED`, `WORLD_COMPLETED`). | Decouples the latency-critical tick loop from database writes. Absorbs bursts. Retries failures. Isolates poison messages. |
| **Async worker (function)** | Consumes events in batches and applies them idempotently to the datastore. | Scales to zero. Retry semantics come from the queue. |
| **Structured key-value store** | Player profiles (best score, deaths, kills), death history, world records, idempotency markers. A secondary index sorted by best score serves the leaderboard. | Durable state lives outside the stateful workers. Key-based access patterns and no table scans. |
| **Read API function** | `GET /api/leaderboard`, `GET /api/player`. | Separates the read path from the game workers: a small microservice, cached at the edge. |
| **Monitoring system** | Collects structured logs, platform metrics, custom game metrics, alarms and dashboards. | Evidence for scaling decisions, failure diagnosis, cost tuning. |

## Key design decision: independent authoritative worlds

* **State lives inside one world worker**, and worlds share no realtime state. A world is the unit of scale: one worker
  process holds 50 snakes (≤ 4 humans) in memory and is the only authority on them.
* Scaling out means **adding worlds**, not splitting a world across machines. That avoids distributed consistency on the
  30 Hz hot path entirely: no cross-node locks, no replicated physics, no consensus. Each tick is a single-threaded loop
  over local memory, which keeps it simple, fast (milliseconds) and deterministic to test.
* **The trade-off:** a crashed or terminated worker loses its world's *transient* state (positions, current lengths).
  That is acceptable for a casual arena game, where a round is short-lived and losing it costs a player one life.
  Everything with long-term value (scores, deaths, best score, leaderboard) is sent as an event to the durable
  queue as it happens, so it survives worker loss. Clients detect the loss and reconnect to another world within seconds.
  Restoring exact world state would need checkpointing or replication at tick rate, which costs more than it is worth here.
* Because each world caps humans at 4, capacity planning is arithmetic:
  `requiredWorlds = ceil(concurrentHumans / 4)`. NPCs are workload (CPU), not users.

## Data and control flows

1. **Join:** browser → CDN → load balancer → some worker. If that world has fewer than 4 humans it accepts. Otherwise it answers
   `ROOM_FULL` and the client retries after a random 150–600 ms jitter, so the load balancer can pick a different worker.
2. **Lobby:** the first human starts a ≤ 10 s countdown. A 4th human starts it immediately. At start, empty slots fill with NPCs.
3. **Gameplay:** client sends intent (heading, boost) at ≤ 20 Hz. The server ticks at 30 Hz (move, collide, eat, grow, kill)
   and sends interest-managed snapshots at 15 Hz. The client interpolates between the last two snapshots.
4. **Persistence:** death or session end → event (with a unique `eventId`) → queue → worker function → conditional
   writes (idempotency marker + aggregate update) → leaderboard index.
5. **Scaling:** workers publish occupancy and tick metrics. The autoscaler adds workers when occupancy/CPU exceed target and
   removes idle ones. Workers with players set *scale-in protection* so the autoscaler never terminates an active world.

## Alternatives considered (and rejected)

| Decision | Chosen | Rejected alternative | Reasoning |
|----------|--------|----------------------|-----------|
| Realtime transport | WebSocket | HTTP polling / long polling | 15 Hz state with polling costs a request per update per client (latency + header overhead + load-balancer cost). WebSocket keeps one full-duplex connection. |
| Realtime transport | WebSocket over TCP | WebRTC data channels / UDP | Lower head-of-line blocking, but needs signalling + TURN infrastructure and is not proxied by standard CDNs/load balancers. Overkill for 15 Hz snapshots. |
| Authority | Server-authoritative | Client-authoritative (original game) | Clients could forge position, score or invulnerability. A server is the only trustworthy referee, and it is required for leaderboard integrity. |
| World topology | Many independent small worlds | One global shared world | A global world needs spatial partitioning across nodes with handover and cross-node collisions. That is far more complex and has a single hot spot. Independent worlds scale linearly. |
| Game compute | Containers (long-running) | Serverless functions | Functions are short-lived and stateless, and they bill per invocation. A 30 Hz in-memory loop with held sockets needs a long-running process. |
| Game compute | Managed containers (serverless container runtime) | Self-managed VMs + container orchestrator | No host patching/capacity management. Per-task billing granularity suits small worlds. VMs would be cheaper only at sustained high utilisation. |
| Persistence write path | Async via queue | Synchronous DB writes from game loop | A sync write adds network latency and failure modes to the tick/connection path, and DB throttling would stall gameplay. The queue absorbs bursts and retries. |
| Static delivery | CDN in front of private object storage | Serve from game servers / public bucket | Game servers would spend CPU and bandwidth on static files. A public bucket has no TLS on a custom path, no edge caching and wider exposure. |
| Datastore | Key-value store with sorted secondary index | Relational DB | Access patterns are key lookups plus "top N by score". A KV store is serverless, pay-per-request and needs no instance. Relational features (joins) are unused. |
| Leaderboard read | Function behind LB, edge-cached 10 s | Read from game workers | Keeps workers focused on simulation. The edge cache absorbs repeated reads. |
| Scaling signal | World occupancy (custom metric) + CPU (platform metric) | CPU only / request count | Request count is meaningless for long-lived WebSockets. Occupancy measures user capacity directly (`humans / 4`). CPU guards against simulation saturation. Both feed target tracking. |
| Lost world | Reconnect to any world | Checkpoint/replicate world state | Replicating at 30 Hz costs more than it is worth for casual sessions. Durable stats are already safe. |
