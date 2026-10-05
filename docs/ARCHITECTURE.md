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

## web (client)

```
src/
├── main.tsx            entry: session from the URL, automation hook, <App/>
├── App.tsx             layout and wiring: session → 3D view + HUD
├── styles.css          HUD styling (dark glass panel over a fullscreen canvas)
├── session/            where the state comes from
│   ├── types.ts        GameSession / SessionSnapshot contract
│   ├── local.ts        in-browser game-core (default)
│   ├── remote.ts       HTTP + WebSocket against packages/server
│   ├── createSession   picks one from ?mode=local|remote
│   ├── dto.ts          runtime validation of everything the server sends
│   ├── store.ts        the window.__minesweeper3d automation hook
│   ├── presets.ts      config → preset id (for the picker)
│   ├── hints.ts        the digging rule, client side, for click hints
│   └── summary.ts      the numbers the HUD displays
├── hooks/              useSession (useSyncExternalStore), timer, shortcuts
├── hud/                plain DOM: status bar, presets, banner, badge, legend
└── three/              the 3D layer
    ├── orbit.ts        pure spherical camera math      (unit tested)
    ├── motion.ts       pure delta-time smoothing       (unit tested)
    ├── board.ts        cell size, palette, framing maths
    ├── assets.ts       textures, cubemap, font and mine loaders
    ├── GameCanvas.tsx  <Canvas>, loading overlay, error boundary
    ├── BoardScene.tsx  lights, background, camera rig, board contents
    ├── CellLayer.tsx   one instanced mesh for all covered cells + mines
    ├── NumberGlyphs.tsx, MineModel.tsx, HoverIndicator.tsx
    └── useCameraRig.ts, useBoardPointer.ts
```

- The session is a tiny observable store (`getSnapshot`/`subscribe`), consumed
  through `useSyncExternalStore`. Swapping local for server play is a factory
  change, nothing else: `?mode=remote` does exactly that.
- Covered cells are a single instanced mesh with per-instance colours and one
  pointer handler set; instance ids *are* grid offsets, so a raycast hit maps
  back to a cell without walking the scene graph.
- three.js objects live in refs and are animated from `useFrame`, never stored
  in React state.
- Camera behaviour (orbit, zoom, retarget, smoothing) lives in pure modules so
  it can be tested without WebGL, and is applied to the r3f camera per frame.
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
├── index.ts        bootstrap: config → store → app → Bun.serve → signals
├── app.ts          composes API routes, WebSocket upgrade and static files
├── router.ts       tiny method + path-pattern router
├── http.ts         JSON/progress-free helpers and HttpError
├── config.ts       environment parsing and validation
├── logger.ts       levelled logger with an injectable sink
├── static.ts       serves packages/web/dist with SPA fallback
├── games/          store → service → DTO → routes (game lifecycle)
└── realtime/       protocol + hub (socket fan-out per game id)
```

- `GameService` is the only writer of game state: it calls the engine, skips
  persistence and broadcasting when a transition changed nothing, bumps
  `revision` and notifies subscribers.
- `GameStore` is an interface with an in-memory implementation, so persistence
  can be added without touching the service.
- The hub is a transport adapter over the service's subscription stream, not a
  second source of truth: it starts listening to a game when its first socket
  connects and stops when the last one leaves. Every accepted mutation is
  therefore broadcast exactly once, no matter whether it arrived over HTTP or
  over a socket — which is the shape a multiplayer room needs.
- Hidden information never leaves the server: responses carry
  `toClientView(state)`, which hides the mine *and* the danger count of every
  covered cell, so a client cannot peek at the board it is playing against.

## Extension points

| Planned feature | Where to build it |
| --- | --- |
| Multiplayer rooms | `realtime/hub.ts` (already fans out per game id) + a room/player model around `GameStore` |
| Persistence, accounts | implement `GameStore` over a database; `games/service.ts` stays as is |
| Alternative rules (2D, no digging, chords) | `rules.ts` predicates + a variant of `revealRegion`; the state shape does not change |
| Bigger boards | `game-core` tests already cover a 10×10×10 board; the client would need instanced meshes |
| Replays | `GameConfig.seed` + the action log; `parseGameState` validates stored states |
