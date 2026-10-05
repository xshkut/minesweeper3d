# Porting notes: the PoC, its behaviour, and what replaced it

This document records what the original single-page prototype did, what was
kept, what was fixed and why. It is the reference for reviewing the rewrite:
every gameplay rule of the new engine is traceable to a line of the old one.

## The original

| File | Role |
| --- | --- |
| `index.js` | 20 lines of express + socket.io: serve `public/`, one empty `connection` handler, listen on 8000 |
| `index.html` | jQuery + vendored `three.js` (r83), `OBJLoader`, `MTLLoader`, `bundle.js` |
| `scripts/entry.js` | everything: scene, camera, lights, loaders, materials, input, render loop |
| `scripts/MineCore.js` | the rules: board, mines, danger counts, reveal, flags, win/lose |
| `scripts/motion.js` | second-order "move towards a point" helper for the camera |
| `scripts/cameraControl.js` | orbit camera singleton (right-drag rotate, wheel zoom, `reset`) |
| `scripts/MultiFlags.js` | counter that fires a callback after *n* async asset loads |
| `scripts/findParentBefore.js` | walks up the three.js graph to map a raycast hit to its cell |
| `webpack.config.js` | bundles `scripts/entry.js` → `public/bundle.js` |
| `public/three.js` | vendored three.js r83 (43k lines) |

## Rules: old implementation → new module

| `MineCore.js` | `packages/game-core` |
| --- | --- |
| `cell[i][j][k].danger` | `Cell.adjacentMines` (mines in the 26 surrounding cells) |
| `cell.mine`, `cell.marker`, `cell.empty` | `Cell.hasMine`, `Cell.isFlagged`, `Cell.isRevealed` |
| `this.r` (cell pitch), `a`, `b`, `c` | `GameConfig.size`, `createGrid()` addressing |
| `random: 10` + `while (minesNumber < random)` | `GameConfig.mineCount` + `placeMines()` |
| `addMine` / `removeMine` | `placeMines()` / `relocateMine()` (internal) |
| `checkCell()`'s `if (around == 6) return;` | `rules.ts#isExposed()` — the digging rule, named and documented |
| `recursiveChecker()` | `game.ts#revealRegion()` — iterative flood fill |
| `cellsNumber` counter | `GameState.revealedCount` + `rules.ts#hasRevealedAllSafeCells()` |
| `this.pickable` | `GameState.status` (`ready`/`playing`/`won`/`lost`) |
| `pickCellOnPosition` (hover highlight, `?` glyph) | React hover state + `three/HoverIndicator` |
| `explode()` / `win()` callbacks | `GameEvent`s (`mineExploded`, `minesRevealed`, `gameWon`, …) |
| `setCell(vector, obj)`, `group.add/remove` | pure state transitions; the renderer reacts to state |

The three genuinely distinctive rules of the prototype were preserved exactly:

1. **Danger counts span all 26 neighbours** (faces, edges, corners), not the 8 of
   the 2D game. `numbers[danger]` therefore has to reach 25.
2. **You dig in from the surface.** A covered cell can only be opened when one of
   its six face neighbours is outside the board or already revealed. The
   prototype expressed this as `around == 6`; the new engine names it
   `isExposed()` and tests it (`test/exposure.test.ts`).
3. **Flags are protected cells**: a flagged cell can neither be opened by a click
   nor by the flood fill.

## Behaviour that was wrong and is now fixed

| # | Prototype behaviour | Why it was wrong | Now |
| --- | --- | --- | --- |
| 1 | `removeMine` set `mine = true` and never decremented `minesNumber` | dead, broken API | removed; mine placement is a validated partial shuffle |
| 2 | `checkCell` decremented `cellsNumber` on *every* call, including clicks on already revealed cells | a false "win" was reachable | `revealedCount` only counts newly opened cells |
| 3 | `recursiveChecker` recursed without a visited set and re-entered blocked cells | order-dependent reveals, unbounded recursion on some boards | iterative fixed-point flood fill, guaranteed to terminate |
| 4 | `while (this.minesNumber < this.random)` retried random cells forever | infinite loop when `mineCount > cells` | `placeMines` throws; the config is validated (mineCount ≤ cells − 1) |
| 5 | `cell.empty` meant both "has no object" and "is revealed" | two concepts in one flag, fragile flood fill | `isRevealed` is explicit; the renderer derives visuals from it |
| 6 | `explode()` mutated the *shared* cube material (`opacity`, `transparent`), `win()` mutated the shared mine material | every covered cube changed appearance at once | materials are per state, mutated nowhere |
| 7 | `scene.add(directionalLight, directionalLight)` — the second light was created but never added | one light missing, first one added twice | both lights added |
| 8 | `cameraControl` read the global `event`, used `onmousewheel`, and was a mutable singleton | brittle, untestable, deprecated API | pure `three/orbit.ts` (unit tested) + a React hook |
| 9 | `findParentBefore.js` created an implicit global and returned `undefined` when the parent was missing | crash on unexpected hits | @react-three/fiber pointer events per cell |
| 10 | `MultiFlags` counted asset loads by hand | easy to deadlock on a failed load | React Suspense + three loaders |
| 11 | No tests, no types, no linting; three.js r83 vendored in-tree | unreviewable, unupgradable | Bun test suite, strict TypeScript, `three` from npm |
| 12 | `event.which == 3`, `altKey`-only flagging, unused handlers (`onMouseMove1`) | deprecated/incoherent input | pointer events, alt/middle click **and** a flag mode |

## Deliberate changes on top of the prototype

These are improvements, not bug fixes. Each one is a config flag or isolated
code path, so the old behaviour is still reachable.

- **Safe opening click** (`GameConfig.firstRevealSafe`, default `true`): if the
  first reveal of a game would hit a mine, the mine is relocated outside the
  26-neighbourhood of that click. The prototype could end a game on the very
  first click with no player agency. Set `firstRevealSafe: false` for the old
  behaviour (`relocateMine` in `game.ts`).
- **Explicit status** (`ready` → `playing` → `won`/`lost`) instead of a
  `pickable` boolean, so the HUD can show a timer that starts with the first
  reveal.
- **Deterministic seeds** (`GameConfig.seed`): a board can be replayed, shared
  by seed and reproduced on the server. The prototype called `Math.random()`
  and had no notion of a game identity.
- **Client view redaction** (`toClientView`): mines are hidden until the game is
  over. Needed as soon as the server owns the game state (multiplayer).
- **Serialisable state**: `GameState` survives `JSON.stringify`/`parse`
  unchanged and is validated on the way back in (`parseGameState`).
- **Mine model scale**: the prototype dropped its mine OBJ into a cell at its
  native ~1 unit size inside a 10 unit cell, so mines were almost invisible.
  The client scales whatever it loads to fit the cell, which is also what lets
  the generated mesh replace the original one without touching the code.
- **Billboarded numbers**: `TextGeometry` meshes face +z in the prototype, so
  numbers were unreadable from most angles. The client turns them toward the
  camera.

## Measured parity with the prototype

The rules port was checked mechanically, not by eye: a harness loaded the
untouched `scripts/MineCore.js` (with a minimal stand-in for the three.js object
graph it mutates) and ran it side by side with `game-core` over the same mine
layouts. Results for a 3×3×3 board:

| Check | Scope | Result |
| --- | --- | --- |
| Danger counts (`danger` vs `adjacentMines`) | 300 layouts × 27 cells = **8100 cells** | **0 mismatches** |
| `mine` flag vs `hasMine` | same 8100 cells | **0 mismatches** |
| Mine-hit outcome (`explode` vs `status: "lost"`) | 120 layouts × 27 clicks = **3240 clicks** | **0 mismatches** |
| Ignored click (blocked/flagged/covered) | 3240 clicks | **0 mismatches** |
| Cells opened by the flood fill | 3240 clicks | 6 differences (0.19 %) |

All six differences are the same story: the prototype leaves one extra cell
covered because its recursion never revisits a cell that *became* diggable later
in the same fill. Example (mines `2,0,2 2,2,0 0,1,0 0,1,1 2,0,1 1,0,1`, click
`2,2,2`):

```
legacy revealed: 1,1,2 1,2,1 1,2,2 2,1,1 2,1,2 2,2,1 2,2,2
modern revealed: 1,1,1 1,1,2 1,2,1 1,2,2 2,1,1 2,1,2 2,2,1 2,2,2
only modern:     1,1,1      <- exposed through the revealed (2,1,1), so it must open
```

The new engine is strictly more generous here and never turns a prototype win
into a loss: the divergence is the fixed-point retry described as bug #3 above.

## Frontend: three.js scene → React

The prototype kept everything in module-level variables of `entry.js` (a scene
graph mutated by `MineCore` through `group.add`/`remove`) and re-created cell
objects on every state change. The rewrite keeps the same visual language but
separates concerns:

- `game-core` owns the rules (no three.js import at all).
- The session layer owns "where does the state come from": in-browser
  (`LocalGameSession`) or the Bun server (`RemoteGameSession`).
- React owns the DOM/HUD and the declarative board rendering; three.js objects
  live in refs and are updated from `useFrame`, never stored in React state.
- Camera math and smoothing moved into pure, unit-tested modules
  (`three/orbit.ts`, `three/motion.ts`) instead of a mutable singleton.

## Backend: express stub → Bun service

The prototype's server only served static files and had an empty socket.io
`connection` handler with a commented-out MongoDB experiment.

The new `packages/server` is a small layered service (config → logger → router →
game service → HTTP/WS + static) that owns authoritative games, validates every
payload with the shared engine, redacts hidden information, and broadcasts state
changes over WebSockets — the seam multiplayer will be built on.
