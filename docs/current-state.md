# Current State (Phase 0 inspection)

Inspected 2026-10-19 before any modification. Source: `https://github.com/CY3639/slither.io-clone`
(a fork of Loonride's 2017 "How to make Slither.io with JavaScript" tutorial; last upstream commit 2018-02-17).

## 1. Repository structure

| Path | Contents |
|------|----------|
| `part-2/` … `part-6/` | Intermediate tutorial snapshots (each a self-contained copy of the game at that tutorial step). |
| `slither-io/` | Final version of the tutorial game. This is the version reused. |
| `slither-io/lib/phaser.min.js` | **Phaser CE v2.6.2** (2016) bundled with the P2 physics engine. |
| `slither-io/src/*.js` | 9 source files, ~600 lines total. |
| `slither-io/asset/*.png` | 7 small PNG sprites (circle, eye-white, eye-black, food, hex, tile, white-shadow). |
| `README.md` | Upstream tutorial README. |

There is no `package.json`, no build step, no tests, no licence file and no server. The game is
opened by loading `index.html`, which includes the scripts as browser globals.

## 2. Language / style

* ES5-style JavaScript: constructor functions plus `prototype` objects, `var`, and globals
  (`Game`, `Snake`, `PlayerSnake`, `BotSnake`, `Food`, `Util`, …). One `const` in `util.js`.
* Phaser 2 state object (`preload` / `create` / `update`), driven by Phaser's requestAnimationFrame loop (~60 fps).

## 3. Current architecture

A single-browser, client-only game. All state lives in the Phaser/P2 physics world in the tab:

```
index.html → Phaser.Game(800x500) → Game state
   ├─ P2 physics world (bounds -800..800 × -500..500)
   ├─ 1 PlayerSnake (mouse / arrow keys, SPACE = boost)
   ├─ 2 BotSnakes (random turning)
   └─ 100 Food sprites (random positions)
```

### Game loop (`game.js`)
`update()` calls `snake.update()` for every snake and `food.update()` for every food sprite every frame.

### Snake representation (`snake.js`)
* `sections[]`: P2 *kinematic* circle sprites. `sections[0]` is the head.
* `headPath[]`: list of points the head has passed through. Each frame the head moves forward
  (`moveForward(speed)`), its position is put at the front of `headPath`, and each section is placed on
  the path at about `preferredDistance = 17 × scale` from the section in front (`findNextPointIndex`).
* Constants: start `scale = 0.6`, 30 starting sections plus the head, `slowSpeed = 130`, `fastSpeed = 200` (px/s),
  `rotationSpeed = 40` (P2 units, which is 2 rad/s after Phaser's px→m factor of 20).
* Growth: `incrementSize()` queues one section and multiplies `scale` by 1.01. Queued sections are added at the tail
  once per "cycle".
* `edge`: an invisible 4 px circle locked to the front of the head. If it touches a section of *another* snake,
  the snake is destroyed. Hits on its own sections are ignored.

### Players and bots
* `PlayerSnake`: rotates toward the mouse pointer (or follows the arrow keys). SPACE sets `fastSpeed` and lights up the shadow.
* `BotSnake`: rotates in one direction at a time and flips direction with probability 1/20 per frame. It does not seek food or avoid anything.

### Food (`food.js`)
* On contact with a head, a revolute constraint pulls the food to the head's centre, then `incrementSize()` runs.
* `snakeDestroyed()` drops food along the dead snake's path (about every second section) with ±10 px jitter.

### Rendering helpers
* `Shadow`: a tinted `white-shadow.png` under each section. It turns bright red-tinted while boosting.
* `Eye` / `EyePair`: white and black circles held on the head by P2 lock/distance constraints. Pupils look toward the mouse.

## 4. What can be reused

| Element | Reuse decision |
|---------|----------------|
| All 7 PNG assets | Reused unchanged by the new client. |
| Phaser CE 2.6.2 | Kept as the renderer, so the original rendering code and assets carry over. |
| Rendering concepts: tinted circle sections, shadow light-up when boosting, eye pair on the head, tiled background | Ported into the new client. P2 constraints are replaced by plain positioning, since the server supplies positions. |
| Movement model: forward speed, turn rate, boost speeds, 30 start sections, `17 × scale` spacing along the head path, growth ×1.01 per food | Ported to the server simulation with the same constants. |
| Death rule: front edge touching another snake's body; own body ignored | Ported to the server. |
| Food dropped along the dead snake's body | Ported to the server. |
| Bot "trend" random turning | Kept as the NPC wander behaviour, with food seeking and danger/boundary avoidance added on top. |

## 5. Multiplayer gaps (what must move or be added)

1. **Authority.** Position, collisions, eating, growth, score and death are all computed by P2 in the browser.
   A multiplayer game cannot trust that. The whole simulation must move to a headless server, and P2 cannot come with it
   because it is tied to Phaser sprites. The server needs a deterministic, dependency-free kinematic model (path-following
   sections plus circle-overlap tests on a spatial grid).
2. **Networking.** None exists. Needed: WebSocket server, join/lobby protocol, input messages, snapshots, food deltas,
   interpolation on the client.
3. **World model.** 1 player + 2 bots in a 1600×1000 world. The target is 50 snakes per world (≤ 4 humans plus NPC fill),
   so the arena has to be much larger, with a boundary.
4. **NPCs.** Random rotation alone would make 46+ NPCs die at the boundary or in each other constantly. They need
   basic avoidance and food seeking.
5. **Identity / UI.** No display name, score, leaderboard, connection status or respawn flow.
6. **Persistence.** None. Results must go to DynamoDB through SQS and Lambda.
7. **Build.** No toolchain. A small Node build script is needed to produce fingerprinted assets for S3/CloudFront.

## 6. Build constraints

* Phaser CE 2.6.2 is a browser global and has no npm/ESM build. The client stays as plain scripts and a small Node script
  concatenates and fingerprints them. No bundler is needed.
* Local toolchain: Node v24.13.1, npm 11.10.1, Docker 29.8.2 (linux/aarch64 engine), AWS CLI 2.36.8, git 2.54.
  The Docker host is arm64, so the server image targets **linux/arm64**, which matches Fargate Graviton.

## 7. AWS constraints discovered

* Account `901444280953`, region `ap-southeast-2`, SSO role `CAB432-STUDENT`.
* Student ID `n5528712`; tag `qut-username = n5528712@qut.edu.au` (from the A2 `submission-infra.yml`). A3 tag: `purpose = assessment 3`.
* **Existing A2 / A1 resources that must not be touched:** `n5528712-a1-*` DynamoDB tables and Lambdas, API Gateway `rw6ev7gjr3`,
  Cognito user pool, `n5528712-a2-*` ECS cluster/services, SQS queues, Lambdas, EventBridge rules, ECR repos `a2/n5528712-*`,
  ACM certificate and Route 53 record for `n5528712.cab432.com`. All A3 resources use the prefix `n5528712-a3-`
  (ECR: `a3/n5528712-*`, following the A2 convention).
* A2 practice shows students can create ECS clusters, ECR repos, SQS, Lambda, DynamoDB, ACM certificates and Route 53 records
  in the shared `cab432.com` zone.
* **Not yet verified** (the SSO session had expired at inspection time): whether CloudFormation and IAM role creation are permitted,
  the available VPC/subnets, and existing IAM roles. These are checked before provisioning (Phase 6) and recorded here.
* Local AWS CLI config: the `CAB432-STUDENT-901444280953` profile has both `sso_session = a2` and a conflicting `sso_start_url`,
  so the CLI refuses it. The default profile (used by the `awsfresh` shell helper) targets the same account and role.
