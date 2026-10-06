# Architecture

```
minesweeper3d/
├── packages/
│   ├── game-core/     pure rules engine   (TypeScript, zero dependencies)
│   ├── server/        Bun HTTP API, WebSocket hub, static hosting
│   └── web/           React 19 + three.js client (Vite)
├── docs/              this file and the porting notes
└── tools/dev.ts       dev launcher (API + Vite in one terminal)
```

Three rules shaped the design:

1. **The rules are a pure library.** `game-core` never imports three.js, React,
   Bun or the DOM. The browser and the server run the *same* engine, so a
   server-authoritative multiplayer game cannot drift from single player.
2. **State is data.** `GameState` is immutable, JSON-serialisable and validated
   on the way in (`parseGameState`), which makes it safe to persist, send over
   the wire, or replay from a seed.
3. **Presentation is a subscriber.** Reveals, flags, camera movement and HUD
   rendering all derive from state plus the `GameEvent`s an action produced.

## game-core

| Module | Responsibility |
| --- | --- |
| `types.ts` | `Vec3`, `Cell`, `GameConfig`, `GameState`, `GameEvent`, `ClientGameState` |
| `grid.ts` | flat-array addressing of the box (`offsetOf`/`cellOf`), the 6 face and 26 surrounding neighbour offsets |
| `random.ts` | seeded mulberry32 generator (`nextRandom`, `randomInt`), so boards are reproducible |
| `board.ts` | mine layout (partial Fisher–Yates), 26-neighbour adjacency counts, cell construction |
| `rules.ts` | the game rules as predicates: `isExposed` (the digging rule), `hasRevealedAllSafeCells`, `isGameOver`, `DEFAULT_RULES` |
| `game.ts` | the state machine: `createGame`, `revealCell`, `toggleFlag`, `toClientView`, plus `GameEvent`s |
| `serialization.ts` | untrusted-input validation and JSON round-tripping |
| `presets.ts` | the named board sizes the menus offer |
| `difficulty.ts` | mine-count ↔ tier conversion (`mineCountFor`, `difficultyOf`, `formatDensity`) and the co-op clock (`coopTimeLimitMs`) |
| `modes.ts` | the match modes (`MATCH_MODES`, `sharesBoard`, `hasEliminations`, `usesClock`) |
| `index.ts` | the public surface (everything else is internal) |

### The action model

```ts
const transition = revealCell(state, { x: 0, y: 0, z: 0 });
transition.state;   // new immutable state (the same reference when ignored)
transition.events;  // [{ type: "cellsRevealed", cells: [...] }, ...]
```

- Actions **never mutate** their input and return the **same reference** when the
  action is ignored (out of bounds, flagged, not exposed, game over). React can
  therefore skip re-renders with a `===` check.
- Actions are the *only* way state changes; there are no setters.
- `GameEvent`s describe what changed for the presentation layer (staggered
  reveal animation, sounds, camera hints) without it having to diff states.

### The reveal algorithm

```
revealCell(cell)
  ├─ ignore unless the cell is covered, unflagged and exposed
  ├─ mine?  → relocate it on the opening click (firstRevealSafe)
  │           otherwise explode: uncover every mine, status = "lost"
  └─ flood fill from the cell:
        pop a candidate; ignore it if revealed, flagged or still blocked
        open it; if it has no adjacent mines, enqueue its 26 neighbours
        when a pass opened something, retry the blocked candidates
        stop when a pass opens nothing or nothing is blocked
```

The retry loop is what lets the fill "dig inwards": a cell that was blocked by
the digging rule becomes openable as soon as one of its face neighbours opens.
`revealRegion` in `game.ts` is documented with that reasoning; the
`docs/PORTING-NOTES.md` parity section shows how it differs from the
prototype's recursion (it opens strictly more, never fewer, safe cells).

### Match modes

The three modes are a table in `modes.ts`, not branches scattered through the
engine. Each row answers four questions the rest of the system asks:

| Mode | Board | Clock | Mines | Round ends when |
| --- | --- | --- | --- | --- |
| `coop` | shared | yes | fatal | the clock runs out (lost) or the cube is cleared (won) |
| `race` | one per player | no | fatal | nobody is still playing — first to clear wins, a mine eliminates that player |
| `survival` | shared | no | **not** fatal | at most one player is left |

- `sharesBoard(mode)` decides whether everyone plays the same `GameState` or
  each seat gets its own board. That single predicate is what makes co-op and
  survival a room-wide score and a race a set of private boards.
- `hasEliminations(mode)` is the only thing that sets `GameConfig.minesFatal`.
  The mode owns that rule, so it is never read from a request body: a survival
  room cannot be talked into a fatal mine by a client.
- `usesClock(mode)` gates the deadline. `coopTimeLimitMs` scales it with the
  board (1.2 s per safe cell, clamped to 60 s … 15 min) rather than a flat
  budget, so a bigger cube is not automatically a loss.
- Mines are counted as *moves* but never as progress: a non-fatal mine sets
  `explodedAt` and emits `mineExploded` **without** a `cellsRevealed` event, so
  `revealedCount` keeps counting mine-free cells only. That is exactly what
  `hasRevealedAllSafeCells` compares against, so a player who steps on a mine
  cannot "win" by detonating the board.

Difficulty is a **derived** property. A bare mine count says nothing without the
board it sits on — 25 mines is dense on a 5³ cube and sparse on a 10³ one — so
`difficultyOf(size, mineCount)` classifies a count by *density* and
`mineCountFor(size, difficultyId)` picks one. The tier's ceiling sits between two
neighbouring nominals, which makes the two functions inverses on every preset
board. Nothing stores a tier beside a count, so the two can never disagree.

## web (client)

```
src/
├── main.tsx            entry: mounts <AppRoot/> in StrictMode
├── AppRoot.tsx         welcome screen → session → <App/>, plus the leave path
├── App.tsx             layout and wiring: session → 3D view + HUD
├── styles.css          HUD styling (dark glass panel over a fullscreen canvas)
├── welcome/            the lobby: create a room or join an open one
│   └── WelcomeScreen   name, mode, cube, mine count/tier, and the room list
├── session/            where the state comes from
│   ├── types.ts        GameSession / SessionSnapshot contract
│   ├── local.ts        in-browser game-core (?mode=local)
│   ├── remote.ts       HTTP + WebSocket against packages/server (default)
│   ├── rooms.ts        lobby HTTP client: list / create / join / leave
│   ├── dto.ts          runtime validation of everything the server sends
│   ├── store.ts        the window.__minesweeper3d automation hook
│   ├── presence.ts     who else is seated, and where they are pointing
│   ├── presets.ts      config → preset id (for the picker)
│   ├── hints.ts        the digging rule, client side, for click hints
│   └── summary.ts      the numbers the HUD displays
├── hooks/              useSession (useSyncExternalStore), timer, shortcuts
├── hud/                plain DOM: status bar, tool switch, room panel, legend
└── three/              the 3D layer
    ├── orbit.ts        pure spherical camera math      (unit tested)
    ├── motion.ts       pure delta-time smoothing       (unit tested)
    ├── board.ts        cell size, palette, framing maths
    ├── trail.ts        pure head-slide + fading-tail maths (unit tested)
    ├── assets.ts       textures, cubemap, font and mine loaders
    ├── GameCanvas.tsx  <Canvas>, loading overlay, error boundary
    ├── BoardScene.tsx  lights, background, camera rig, board contents
    ├── CellLayer.tsx   one instanced mesh for all covered cells + mines
    ├── NumberGlyphs.tsx, CellMarks.tsx   marks drawn *on* a cube, offset to camera
    ├── MineModel.tsx, HoverIndicator.tsx, PlayerCursors.tsx
    └── pointerState.ts, useCameraRig.ts, useBoardPointer.ts
```

- The session is a tiny observable store (`getSnapshot`/`subscribe`), consumed
  through `useSyncExternalStore`. The app starts with **no** session: `AppRoot`
  shows the welcome screen, and only when a room has been created or joined
  does it build a `RemoteGameSession` from the returned `RoomJoinDto`. In local
  mode (`?mode=local`) it skips the lobby and builds the in-browser session
  immediately, which is also what the component tests do.
- A room session is server-authoritative: the client sends reveals and flags
  over the socket and renders whatever `update` frames come back, so two tabs
  in one room cannot diverge. An `update` carrying a `board` names the player it
  belongs to: a race sends one such frame per seat on the room channel and the
  client drops every frame that is not its own, while a frame with no `board` is
  the cube the room shares and is always applied.
- The lobby keeps the mine count, not the tier, as its source of truth: moving
  the slider re-derives the tier badge, and switching cube rescales the count by
  *density* so resizing does not silently change how hard the board is. Picking a
  mode re-seeds the count from that mode's recommended tier. Whatever the player
  ends up choosing is sent as `mineCount`, and the tier the server reports back
  is derived from it.
- Covered cells are a single instanced mesh with per-instance colours and one
  pointer handler set; instance ids *are* grid offsets, so a raycast hit maps
  back to a cell without walking the scene graph.
- three.js objects live in refs and are animated from `useFrame`, never stored
  in React state.
- Camera behaviour (orbit, zoom, retarget, smoothing) lives in pure modules so
  it can be tested without WebGL, and is applied to the r3f camera per frame.
- A finger and a mouse share one pointer path but not one threshold
  (`three/pointerState.ts`): a mouse drag orbits from the first pixel, while a
  finger is allowed a wobble and still counts as a tap. From there the gestures
  divide - a finger that travels orbits, a finger that rests marks the cell under
  it, two fingers pinch to zoom - and the mouse's right-drag, right-click and
  wheel are untouched.
- In a room, where each player is pointing is broadcast to the other seats and
  drawn as a sliding head with a fading tail (`three/PlayerCursors.tsx`, the
  maths in `three/trail.ts`). A pointer is a hint, not an action: the server
  accepts a cell outside the board and never consults it while playing. Pointer
  frames never touch React state - `session/presence.ts` keeps a mutable feed
  that the render loop polls once per frame, so a busy room cannot re-render the
  HUD - and every seat's colour comes from `playerColor()`, which the room roster
  repeats as a swatch beside the player's name.
- Everything the server sends is validated at the boundary (`session/dto.ts`),
  so protocol drift surfaces as a readable error instead of a broken board.
- The game-over banner is deliberately translucent, sits above the middle of the
  board and lets pointer events through to the canvas (only the replay button
  takes them), so the mines it left behind stay visible and the board can still
  be turned to inspect them. `src/styles.test.ts` pins that contract down and
  the browser smoke test measures the board showing through the panel.

## server

```
src/
├── index.ts        bootstrap: config → stores → services → app → Bun.serve → signals
├── app.ts          composes API routes, WebSocket upgrades and static files
├── router.ts       tiny method + path-pattern router
├── http.ts         JSON/progress-free helpers and HttpError
├── config.ts       environment parsing and validation
├── logger.ts       levelled logger with an injectable sink
├── static.ts       serves packages/web/dist with SPA fallback
├── games/          store → service → DTO → routes (game lifecycle)
├── rooms/          store → service → DTO → routes (rooms, seats, presence)
├── state/          snapshot (the on-disk document) + persistence (its stores)
└── realtime/       protocol + hub (socket fan-out per channel)
```

- `GameService` is the only writer of game state: it calls the engine, skips
  persistence and broadcasting when a transition changed nothing, bumps
  `revision` and notifies subscribers.
- `RoomService` owns the player model: it creates a room around a fresh game,
  seats and re-seats players (a `playerId` reclaims its seat across a refresh),
  tracks how many live sockets each player has, and deletes a room once the last
  player leaves or nobody has changed it for a day. Presence is *derived* from
  the connection count, never stored as a flag, so closing one of two tabs
  cannot make a player vanish.
- A room is `public` or `private`. There are no accounts, so private does not
  mean *locked*, it means *unlisted*: the lobby route asks for
  `listRooms({ visibility: "public" })` and a private room is reachable only by
  its code, which is why the code is ten characters of a 31-symbol alphabet
  (~49 bits) rather than something short enough to read out loud. The client
  keeps the code in the page URL and the seat id in `localStorage`, so a shared
  link or a refresh rejoins the same seat.
- The same service owns the *match*: `RoomRecord` carries the mode, the config,
  the round number, the per-seat board ids and an optional deadline. Every
  mutation funnels through one helper that maps a player to their board
  (`sharesBoard(mode) ? room.gameId : room.boards[playerId]`), folds the
  resulting events into that player's score, arms the co-op clock on the first
  accepted reveal, and then latches the round status. The status is latched on
  purpose: once a round is won or lost a late reveal from another socket cannot
  reopen it. A race player whose own cube explodes is marked `out` and keeps
  watching — their mine costs them their board, not the match.
- `GameStore` and `RoomStore` are interfaces with in-memory implementations, so
  persistence can be added without touching either service.
- `state/persistence.ts` is that addition, and it is *only* that: it wraps the
  same two interfaces, hands the services the wrappers, and turns a write into
  "mark dirty, then write later". The write is debounced (250 ms) so a flood
  fill's thousands of saves become one document, serialised through a promise
  queue so two snapshots never interleave, and atomic — `state.json.tmp` renamed
  over the target, so a crash mid-write leaves the previous document readable.
  Restoring installs records verbatim (`restore`, not `save`) and therefore
  marks nothing dirty: the stores then hold exactly what the file held.
- `state/snapshot.ts` owns the document, and two rules keep it trustworthy. It
  **never trusts the file**: every record goes back through the engine's own
  parsers, and one bad record is reported and left out rather than taking the
  process down; only a whole-document problem (not JSON, unknown version) means
  "start empty". And it **never writes down live state**: a player's socket count
  belongs to the process that wrote the file, so it is projected to zero on write
  and forced to zero on read, and a room's difficulty tier is re-derived from its
  mine count rather than believed. The tier is the one derived value a stale copy
  of which would mislabel a board.
- Room lifetime is a sliding TTL, not an idle timer: every accepted change
  restamps `updatedAt` (that is what makes it slide), and `pruneExpired` drops
  anything older than `ROOM_TTL_MS` (24 h). It is deliberately *not* gated on the
  connection count — a room whose players are still connected but who stopped
  playing is exactly the room the TTL is for. Sweeping happens when the lobby is
  listed and on an optional periodic timer (`sweepIntervalMs`); dropping a room
  takes its boards with it, via `GameService.deleteGame`, or a long-lived server
  would keep one board per room it had ever expired.
- A restored room with a `deadlineAt` has its co-op clock re-armed when the
  service is constructed, which is why `startServer` restores the stores *before*
  it builds the services. A deadline that has already passed yields a zero delay
  and ends the round, which is correct: the clock ran while the process was down.
- The hub is a transport adapter over the services' subscription streams, not a
  second source of truth: it fans out per *channel* — a game id for the private
  game API, `room:<id>` for a room — and starts listening when the first socket
  connects and stops when the last one leaves. Every accepted mutation is
  therefore broadcast exactly once, no matter whether it arrived over HTTP or
  over a socket. A room channel watches the room *and* every board the round is
  played on, so a restart re-points the watch and pushes the new boards to
  everyone; a per-seat board is fanned out socket by socket to its owner only,
  which is how a race keeps its boards private on a shared channel.
- Hidden information never leaves the server: responses carry
  `toClientView(state)`, which hides the mine *and* the danger count of every
  covered cell, so a client cannot peek at the board it is playing against.

## Extension points

| Planned feature | Where to build it |
| --- | --- |
| A new match mode | add a row to `MATCH_MODES` in `game-core/src/modes.ts` and branch on `sharesBoard`/`usesClock`/`hasEliminations` where they are already consulted; the room record needs no new field |
| Turn-based or scored modes | `rooms/service.ts` already owns the seats, the per-player boards and `revealedCount`; a turn order belongs in `RoomRecord` |
| Per-player colour | the player list in `hud/RoomBadge.tsx` and the seat ids from `RoomDto`; the server already knows who is connected |
| Persistence, accounts | the JSON snapshot covers restarts; a database means implementing `GameStore` and `RoomStore` again, which is what `state/persistence.ts` already demonstrates |
| Reconnection after a room expired | seat reclaim exists (`join` with a `playerId`) and a restart now reloads the room, but a room older than `ROOM_TTL_MS` is gone; a durable store with a longer retention would be the place to change that |
| Alternative rules (2D, no digging, chords) | `rules.ts` predicates + a variant of `revealRegion`; the state shape does not change |
| Bigger boards | `game-core` tests already cover a 10×10×10 board; the client would need instanced meshes |
| Replays | `GameConfig.seed` + the action log; `parseGameState` validates stored states |
