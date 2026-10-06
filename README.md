# Minesweeper 3D

A minesweeper played inside a cube: 26-neighbour danger counts, and mines you
have to dig towards from the surface instead of clicking anywhere.

![A partly excavated 5x5x5 board with the HUD open](docs/screenshot.jpg)

The original prototype was a single-page PoC (one 253-line `entry.js`, a
vendored three.js r83, an express stub). It has been rebuilt as a typed,
tested monorepo: a pure rules engine shared by the browser and the server, a
Bun + TypeScript backend and a React + three.js client.

```
packages/game-core   pure, dependency-free rules engine  (bun test)
packages/server      Bun HTTP API + WebSocket hub + static hosting
packages/web         React 19 + three.js client (Vite)
```

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and
[docs/PORTING-NOTES.md](docs/PORTING-NOTES.md) for what the prototype did, which
of its bugs are fixed, and the measured behavioural parity with the new engine.

## Quick start

```bash
bun install

bun run dev        # API on http://localhost:8000 + Vite dev server on http://localhost:5173
```

Open http://localhost:5173.

Production mode serves the built client and the API from one Bun process:

```bash
bun run build      # builds packages/web into packages/web/dist
bun run start      # http://localhost:8000
```

Either way the app opens on a **welcome screen**: create a room and share its
code, or join one that is already open. The board is server-authoritative by
default; append `?mode=local` to play offline in the browser instead.

## Rooms

Every module — the mine layout, the flood fill, the flags — lives on the
server, so a room is simply a shared game plus the players seated at it:

- `POST /api/rooms` creates a room and seats the caller as host. The response
  carries the room (with its 10-character share code), the player and the board.
  The body picks the match: `mode`, `presetId` and either an explicit
  `mineCount` or a `difficultyId`, plus `visibility`.
- `POST /api/rooms/:id/join` seats another player; `GET /api/rooms` lists the
  open rooms the welcome screen offers, each with its mode and mine tier.
- A room is either **public** (listed in the lobby) or **private** (unlisted:
  the code or the link is the only way in). There are no accounts, so a private
  room is not *locked*, it is *hidden* — which is why the share code is long
  enough not to be guessed rather than short enough to read out loud.
- One WebSocket per seat (`/api/rooms/:id/ws?player=<id>`) relays every accepted
  reveal and flag to the whole room, and announces joins, leaves and the
  connected/away state of each player.
- The cell under a player's pointer is relayed the same way, so the room can see
  where everybody is looking: it is drawn on the cube as a point that slides
  after them with a fading tail, in the colour the roster shows beside their
  name. A pointer is a **hint, not an action** — it never touches the board, the
  server accepts a cell outside it, and a room that is busy pointing does not
  re-render anybody's HUD.
- `POST /api/rooms/:id/restart` starts a fresh board for everyone; "New game"
  keeps the current size, the preset picker resizes the shared cube.

All of it is **in memory** — the services never touch a map — but the whole
thing is snapshotted to a temporary JSON file, so restarting the server picks the
open rooms back up. See [Persistence and room lifetime](#persistence-and-room-lifetime).

A seat can be reclaimed rather than duplicated: `POST /api/rooms/:id/join` accepts
the `playerId` the previous call returned, in which case it renames and reuses
that seat instead of adding a new player. The client keeps both the name you
typed and the seat it was given in `localStorage`, so a reload rejoins as
yourself instead of seating a ghost. The room code is also kept in the page URL
(`/?room=CODE`), which makes the link shareable: opening it joins that room
straight away, and Back returns to the lobby.

## Persistence and room lifetime

The server keeps every room in memory and snapshots it to one JSON file, so a
restart resumes the rooms that were open instead of losing them:

- **It is a temporary file.** The default is
  `<tmpdir>/minesweeper3d/state-<port>.json` — one file per port, so two servers
  on one host do not overwrite each other. `STATE_FILE=path/to/state.json` moves
  it (a relative path resolves against the working directory), and
  `STATE_FILE=off` keeps the state purely in memory.
- **Writes never block a request.** A save only marks the document dirty and
  arms a debounce (250 ms); the file is written from the event loop afterwards.
  That also collapses the storm of saves one flood fill produces into a single
  document. Shutdown (`SIGINT`/`SIGTERM`) flushes once more before exiting.
- **The file is replaced, never mutated.** A snapshot goes to `state.json.tmp`
  and is renamed over the target, so a crash mid-write leaves the previous
  document readable instead of a truncated one.
- **A broken file is not fatal.** It is a cache of live state: one that cannot be
  parsed, or that was written by a layout this build does not know, is logged and
  ignored, and the server starts empty. Individual unusable records are reported
  and left out rather than taking the file down with them.
- **Live state is not written down.** A player's socket count describes the
  process that wrote the file, so it is projected away on write and forced to
  zero on read: after a restart everyone counts as away until they reconnect. The
  difficulty tier is re-derived from the mine count for the same reason — a stale
  copy of a derived value is a mislabelled board.
- **A running co-op countdown survives.** A restored room with a deadline re-arms
  its timer on boot; one whose clock ran out while the server was down ends the
  round, because the clock really did run out.

Rooms also expire. A room nobody has changed for **24 hours** is dropped, boards
and all (`ROOM_TTL_MS` changes the window). The TTL *slides*: every accepted
reveal, mark, probe, join, leave or presence change restamps it, so only a room
left genuinely alone for a day goes away. It measures staleness rather than
emptiness on purpose — a room whose players are still connected but who stopped
playing is exactly the room the TTL is for.

## Match modes

A room plays one of three modes, chosen when it is created. The mode fixes the
rules for the whole match, so it cannot be changed afterwards.

| Mode | Board | How it ends |
| --- | --- | --- |
| **Co-op** | one cube, shared by everyone | the room digs together against a clock; it starts on the first reveal, and running it out loses the round. Clearing the cube first wins it for everybody |
| **Race** | one identical cube per player | the first player to clear their own cube wins and freezes the rest; a fatal mine eliminates that player, not the round |
| **Survival** | one cube, shared, mines are **not** fatal | a mine knocks that player out of the round; the last player still holding a safe cube wins |

Co-op and survival share a board, so every player sees the same cells and
`revealedCount` is a room-wide score. Race deals each seat its own cube built
from the same seed and config; the server sends a race board only to the player
it belongs to, tagging each frame with that player's id, and the client drops the
ones that are not its own. A non-fatal mine still counts as a move but never as
progress, which is why `revealedCount` keeps counting mine-free cells only.

## Difficulty

The mine count is adjustable on every board size, and the lobby shows what the
count *means*: a tier name derived from the mine **density**, so it is still
honest after a resize. The four tiers are `easy` (5% of cells), `normal` (9%),
`hard` (14%) and `super-hard` (20%). They classify density rather than a fixed
count because 25 mines is a dense little 5³ cube and a sparse 10³ one — a bare
number says nothing without the board it sits on. The tier is always derived from
the count, never stored beside it, so the two can never disagree.

The co-op clock is derived from the board too: 1.2 seconds per safe cell,
clamped between one and fifteen minutes.

Restarting (`POST /api/rooms/:id/restart`) starts the next round on the same size
and mine count with a fresh seed, and bumps the round number the HUD shows.

## Controls

The left panel has a three-way tool switch, because a click has to mean one
thing at a time. The tool decides what a left click does; the shortcuts below
are what make switching cheap.

| Input | Action |
| --- | --- |
| Left click | Use the selected tool on the nearest cell |
| `1` | Dig — reveal a cell (only cells exposed to the surface can be opened) |
| `2`, `F` | Mark — cycle the cell's mark: flag, question mark, nothing |
| `3`, `Q` | Detector — spend a free reveal to learn whether a cell hides a bomb |
| `Alt` + click, middle click | Cycle the mark, whatever tool is selected |
| `R` | New game on the current preset |
| Right drag | Orbit the camera |
| Wheel | Zoom |
| Right click | Focus the camera on the clicked cell |
| Move the mouse over the board | Show the room where you are pointing (a hint, not a move) |

### Touch

A finger cannot hold a modifier or read a hover, so the board treats a tap and a
drag as different intents and gives the mark tool a gesture of its own.

| Gesture | Action |
| --- | --- |
| Tap | Use the selected tool on the cell under the finger |
| Drag | Orbit the camera — a finger that travels never acts on a cell |
| Two-finger pinch | Zoom |
| Rest a finger on a cell | Mark it, whatever tool is selected (same as `Alt` + click) |
| Drag a finger across the board | Orbit the camera, and show the room where the finger is |
| Tap the panel handle | Fold the tool panel in or out; a phone starts with it folded away |

The finger's own reach is not the only limit: a tap is only a tap while it stays
within a fingertip's wobble, so a press that moves further than 10px orbits
instead of acting, and a long rest marks rather than digs. With the panel folded
away a small strip along the top keeps the mine counter and the clock in view,
and it never takes a tap itself.

## Marks and the detector

A cell carries at most one mark, and marking cycles through all three states, so
there is no separate "unflag": press again to move on. A flag protects a cell
from being dug; a question mark records doubt without protecting anything.

The detector is the odd one out, and is deliberately not the same thing as a
dig. It spends one of the board's free reveals to answer a single yes/no
question about a *covered* cell, so unlike a dig it works on a cell that is not
yet exposed to the surface — the inside of the cube is exactly where you cannot
see. It never reveals anything else, never counts towards progress, and never
starts a co-op clock: the engine counts only mine-free revealed cells as
progress, so a probe has to stay out of that count or the win condition would
fire early.

The budget is per room and opt-in. The lobby defaults it to 0 (aid off), the
room HUD shows `left / total` only when it is on, and the tool button is
disabled with an explanatory title once the charges run out — a click that
silently does nothing is worse than a button that says why. In the modes that
share one cube (co-op, survival) the budget is shared, exactly like the board;
in a race every player gets their own charges on their own cube.

Both marks and probe verdicts are drawn *on* the cube — the question mark as an
extruded glyph, a probe result as a ball (green for safe, red for a mine) plus a
tint on the cube itself. They float towards the camera, because a glyph at the
cell centre sits inside an opaque cube and is never drawn at all;
`MARK_OFFSET` in `packages/web/src/three/board.ts` is that distance and
`board.test.ts` pins the bound it has to beat.

## Commands

| Command | What it does |
| --- | --- |
| `bun run dev` | API (watch mode) + Vite dev server together |
| `bun run dev:server` / `bun run dev:web` | One side only |
| `bun run build` | Production build of the client |
| `bun run start` | Serve API + built client from Bun (default port 8000) |
| `bun test` | Unit + integration tests of all packages |
| `bun run typecheck` | `tsc --noEmit` for all packages |
| `bun run check` | Typecheck + tests |
| `bun run test:e2e` | Browser smoke test (builds, boots the server, plays a move) |

## The rules that make it 3D

1. **Danger counts span all 26 neighbours** — faces, edges and corners — so a
   cell can show up to 25. Implemented in `computeAdjacency`.
2. **You dig in from the outside.** A covered cell can only be opened when one
   of its six face neighbours is outside the board or already revealed
   (`isExposed`). That is what turns the board into something you excavate.
3. **The opening click never hits a mine** (`firstRevealSafe`, on by default):
   the mine is relocated instead. Set it to `false` for the original,
   merciless behaviour.
4. Marks live on the cube, not beside it: a flag protects a cell from both
   clicks and the flood fill, a question mark protects nothing, and either one
   is replaced by a probe verdict when you spend a charge on that cell.

## Tests

| Suite | What it covers |
| --- | --- |
| `packages/game-core/test` | the rules: layout, adjacency, the digging rule, flood fill, flags, win/lose, safe opening, serialisation and a fuzzing suite of state invariants |
| `packages/server/test` | config, store/service semantics, the REST contract, static hosting, rooms (create/join/leave/restart, presence, redaction), the realtime channel over real WebSockets, and the state file (round trip, corrupt and half-readable files, the sliding TTL) |
| `packages/web/test` | pure camera/orbit maths, the local and remote sessions (with injected transport), the lobby client and welcome screen, the HUD and the app shell (Canvas mocked, no WebGL) |
| `packages/web/e2e` | a real browser: builds, boots the server, creates a room, plays a move, screenshots the board, drives a phone-sized touch context through taps, swipes and a pinch, moves one player's pointer into a second client's room, and restarts the server to prove the room is still there |

```bash
bun run check      # typecheck + every unit/integration suite
bun run test:e2e   # needs a Chromium/Chrome binary (CHROME_PATH overrides)
```

## Known rough edges

- Numbers of *deep* layers overlap when the excavated side is viewed head-on;
  orbiting (or zooming) separates them. A recessed "floor" per revealed cell
  would read better and is the obvious next visual step.
- The board is one draw call for the covered cells but one mesh per mine; a
  10×10×10 board with 80 mines is fine, larger boards would want instancing
  there as well.
- The client bundle is a single ~1.2 MB chunk (three.js is most of it); code
  splitting is not worth it until there is more than one screen.

## Where to go next

The seams for the planned work are already in place:

- **Multiplayer**: rooms, seats, presence and three match modes exist and every
  accepted state change is broadcast to the whole room over one channel per room.
  The seat is remembered client-side and the room code lives in the URL, so a
  refresh or a shared link rejoins the same seat, and every player already has a
  colour the room can see. What is missing is a way to play with strangers: the
  lobby lists rooms but there is no matchmaking and no chat.
- **Accounts / a durable store**: the state already lives behind the `GameStore`
  and `RoomStore` interfaces and is snapshotted to one JSON file, so the next
  step is the same interfaces over a database — plus accounts, which is what
  would make a seat survive more than a `localStorage` entry.
- **Offline mode**: the `game-core` engine still runs in the browser through
  `?mode=local`, which is what the unit tests use.
