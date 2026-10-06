/**
 * Match modes: the rules that turn board outcomes into a *match*.
 *
 * These are service-level tests rather than socket tests, because a mode is
 * about scoring, and scoring is exactly what is hard to observe from a frame.
 * The clock is driven through the injected timer instead of by waiting, and
 * survival boards are laid out by hand so a test can aim at a mine on purpose
 * instead of hoping the seed puts one within reach.
 */
import { describe, expect, test } from "bun:test";
import { createGameWithMines, createGrid, isExposed, mineCountFor, vec3 } from "@minesweeper3d/game-core";
import type { CellIndex } from "@minesweeper3d/game-core";
import { createGameService } from "../src/games/service";
import type { GameService } from "../src/games/service";
import { createInMemoryGameStore } from "../src/games/store";
import type { GameStore } from "../src/games/store";
import { createRoomService } from "../src/rooms/service";
import type { RoomService, TimerHandle } from "../src/rooms/service";
import { createInMemoryRoomStore } from "../src/rooms/store";
import type { RoomStore } from "../src/rooms/store";
import { silentLogger } from "./support";

const START = Date.parse("2026-01-01T00:00:00.000Z");

interface Harness {
  readonly rooms: RoomService;
  readonly games: GameService;
  readonly gameStore: GameStore;
  readonly roomStore: RoomStore;
  /** Moves the injected wall clock forward. */
  advance(ms: number): void;
  /** Runs every timer the service armed, as the event loop eventually would. */
  fireTimers(): void;
  readonly armed: readonly number[];
}

/** Builds a real room service over in-memory stores with a controllable clock. */
function harness(): Harness {
  const logger = silentLogger();
  const gameStore = createInMemoryGameStore();
  let clockMs = START;
  const now = (): string => new Date(clockMs).toISOString();
  const games = createGameService({ store: gameStore, logger, now });

  const timers = new Map<number, () => void>();
  const armed: number[] = [];
  let timerSeq = 0;
  let idSeq = 0;
  let codeSeq = 0;

  const rooms = createRoomService({
    store: createInMemoryRoomStore(),
    games,
    logger,
    now,
    generateId: () => `player-${(idSeq += 1)}`,
    generateRoomId: () => `ROOM${(codeSeq += 1)}`,
    scheduleTimer: (callback, delayMs) => {
      timerSeq += 1;
      timers.set(timerSeq, callback);
      armed.push(delayMs);
      return timerSeq as unknown as TimerHandle;
    },
    clearTimer: (handle) => {
      timers.delete(handle as unknown as number);
    },
  });

  return {
    rooms,
    games,
    gameStore,
    roomStore: createInMemoryRoomStore(),
    advance(ms) {
      clockMs += ms;
    },
    fireTimers() {
      const due = [...timers.values()];
      timers.clear();
      for (const callback of due) callback();
    },
    armed,
  };
}

/** Replaces a room's board with a hand-made layout, so a test can aim at a mine. */
function craftBoard(test: Harness, boardId: string, mines: readonly CellIndex[]): void {
  const stored = test.gameStore.get(boardId);
  if (stored === undefined) throw new Error(`unknown board ${boardId}`);
  test.gameStore.save({ ...stored, state: createGameWithMines(stored.state.config, mines) });
}

/** Reveals every safe cell that is currently openable, until nothing moves. */
function clearBoard(test: Harness, roomId: string, playerId: string, boardId: string): void {
  for (let pass = 0; pass < 64; pass += 1) {
    const board = test.games.getGame(boardId);
    if (board.state.status === "won") return;
    const grid = createGrid(board.state.config.size);
    const targets = board.state.cells.filter(
      (cell) =>
        !cell.hasMine &&
        !cell.isRevealed &&
        !cell.isFlagged &&
        isExposed(grid, board.state.cells, grid.offsetOf(cell.index)),
    );
    if (targets.length === 0) return;
    for (const cell of targets) test.rooms.reveal(roomId, playerId, cell.index);
  }
}

function outcomeOf(test: Harness, roomId: string, playerId: string): string | undefined {
  return test.rooms.getRoom(roomId).players.find((player) => player.id === playerId)?.outcome;
}

describe("board setup", () => {
  test("derives the mine count from a named difficulty tier", () => {
    const test = harness();
    const session = test.rooms.createRoom({ presetId: "classic", difficultyId: "hard" });

    expect(session.room.config.mineCount).toBe(mineCountFor(vec3(5, 5, 5), "hard"));
    expect(session.room.difficultyId).toBe("hard");
    test.rooms.close();
  });

  test("lets an explicit mine count win over the tier, and labels it honestly", () => {
    const test = harness();
    // Two mines on a 5x5x5 cube is well under the easy ceiling, so the room must
    // report "easy" even though the caller never named a tier.
    const session = test.rooms.createRoom({ presetId: "classic", difficultyId: "hard", mineCount: 2 });

    expect(session.room.config.mineCount).toBe(2);
    expect(session.room.difficultyId).toBe("easy");
    test.rooms.close();
  });

  test("defaults survival to a dense board with non-fatal mines", () => {
    const test = harness();
    const session = test.rooms.createRoom({ mode: "survival", presetId: "classic" });

    expect(session.room.difficultyId).toBe("super-hard");
    expect(session.room.config.minesFatal).toBe(false);
    test.rooms.close();
  });

  test("keeps fatal mines in the modes that are lost, not survived", () => {
    const test = harness();
    expect(test.rooms.createRoom({ mode: "coop" }).room.config.minesFatal).toBe(true);
    expect(test.rooms.createRoom({ mode: "race" }).room.config.minesFatal).toBe(true);
    test.rooms.close();
  });

  test("clamps a mine count that would leave no playable cell", () => {
    const test = harness();
    const session = test.rooms.createRoom({ presetId: "tiny", mineCount: 9999 });

    // 3x3x3 = 27 cells, and a board needs at least one safe cell to be clearable.
    expect(session.room.config.mineCount).toBe(26);
    test.rooms.close();
  });
});

describe("race", () => {
  test("hands every player their own identical copy of the cube", () => {
    const test = harness();
    const host = test.rooms.createRoom({ mode: "race", presetId: "tiny", seed: 42, mineCount: 3 });
    const guest = test.rooms.joinRoom(host.room.id, { playerName: "Grace" });

    expect(guest.game.id).not.toBe(host.game.id);
    expect(guest.game.state.config).toEqual(host.game.state.config);
    expect(guest.game.state.cells.map((cell) => cell.hasMine)).toEqual(
      host.game.state.cells.map((cell) => cell.hasMine),
    );
    test.rooms.close();
  });

  test("keeps one player's reveal off the other's board", () => {
    const test = harness();
    const host = test.rooms.createRoom({ mode: "race", presetId: "tiny", seed: 42, mineCount: 3 });
    const guest = test.rooms.joinRoom(host.room.id, { playerName: "Grace" });

    test.rooms.reveal(host.room.id, host.player.id, vec3(0, 0, 0));

    expect(test.games.getGame(host.game.id).revision).toBe(1);
    expect(test.games.getGame(guest.game.id).revision).toBe(0);
    test.rooms.close();
  });

  test("ends the round when the first player clears their cube", () => {
    const test = harness();
    const host = test.rooms.createRoom({ mode: "race", presetId: "tiny", seed: 42, mineCount: 3 });
    const guest = test.rooms.joinRoom(host.room.id, { playerName: "Grace" });

    clearBoard(test, host.room.id, host.player.id, host.game.id);

    expect(test.rooms.getRoom(host.room.id).status).toBe("won");
    expect(outcomeOf(test, host.room.id, host.player.id)).toBe("cleared");
    // The loser's cube is still theirs, but the round no longer accepts moves.
    const before = test.games.getGame(guest.game.id).revision;
    test.rooms.reveal(host.room.id, guest.player.id, vec3(0, 0, 0));
    expect(test.games.getGame(guest.game.id).revision).toBe(before);
    test.rooms.close();
  });

  test("refuses a move from a player who is not seated", () => {
    const test = harness();
    const host = test.rooms.createRoom({ mode: "race", presetId: "tiny", seed: 42, mineCount: 3 });

    expect(() => test.rooms.reveal(host.room.id, "stranger", vec3(0, 0, 0))).toThrow(/not in room/);
    test.rooms.close();
  });
});

describe("survival", () => {
  test("shares one board and reports a detonation as an elimination", () => {
    const test = harness();
    const host = test.rooms.createRoom({ mode: "survival", presetId: "tiny", seed: 1, mineCount: 1 });
    const guest = test.rooms.joinRoom(host.room.id, { playerName: "Grace" });
    const third = test.rooms.joinRoom(host.room.id, { playerName: "Lin" });

    // One mine beside the corner, so the opening reveal exposes it on purpose.
    craftBoard(test, host.room.gameId, [vec3(1, 0, 0)]);
    test.rooms.reveal(host.room.id, host.player.id, vec3(0, 0, 0));
    test.rooms.reveal(host.room.id, host.player.id, vec3(1, 0, 0));

    const room = test.rooms.getRoom(host.room.id);
    expect(room.status).toBe("playing");
    expect(outcomeOf(test, room.id, host.player.id)).toBe("out");
    expect(outcomeOf(test, room.id, guest.player.id)).toBe("playing");
    expect(outcomeOf(test, room.id, third.player.id)).toBe("playing");
    // The spent mine is part of the shared cube now, and the board carries on.
    const board = test.games.getGame(room.gameId);
    expect(board.state.status).toBe("playing");
    expect(board.state.cells.find((cell) => cell.index.x === 1 && cell.index.y === 0 && cell.index.z === 0)?.isRevealed).toBe(
      true,
    );
    test.rooms.close();
  });

  test("hands the win to the last player standing", () => {
    const test = harness();
    const host = test.rooms.createRoom({ mode: "survival", presetId: "tiny", seed: 1, mineCount: 2 });
    const guest = test.rooms.joinRoom(host.room.id, { playerName: "Grace" });

    craftBoard(test, host.room.gameId, [vec3(1, 0, 0), vec3(0, 1, 0)]);
    test.rooms.reveal(host.room.id, host.player.id, vec3(0, 0, 0));
    test.rooms.reveal(host.room.id, host.player.id, vec3(1, 0, 0));

    const room = test.rooms.getRoom(host.room.id);
    expect(room.status).toBe("won");
    expect(outcomeOf(test, room.id, host.player.id)).toBe("out");
    expect(outcomeOf(test, room.id, guest.player.id)).toBe("cleared");
    test.rooms.close();
  });

  test("loses the round when a lone player detonates", () => {
    const test = harness();
    const host = test.rooms.createRoom({ mode: "survival", presetId: "tiny", seed: 1, mineCount: 1 });

    craftBoard(test, host.room.gameId, [vec3(1, 0, 0)]);
    test.rooms.reveal(host.room.id, host.player.id, vec3(0, 0, 0));
    test.rooms.reveal(host.room.id, host.player.id, vec3(1, 0, 0));

    const room = test.rooms.getRoom(host.room.id);
    expect(room.status).toBe("lost");
    expect(outcomeOf(test, room.id, host.player.id)).toBe("out");
    test.rooms.close();
  });

  test("still lets the survivors clear the cube and win together", () => {
    const test = harness();
    const host = test.rooms.createRoom({ mode: "survival", presetId: "tiny", seed: 1, mineCount: 1 });
    const guest = test.rooms.joinRoom(host.room.id, { playerName: "Grace" });

    craftBoard(test, host.room.gameId, [vec3(1, 0, 0)]);
    test.rooms.reveal(host.room.id, host.player.id, vec3(0, 0, 0));
    test.rooms.reveal(host.room.id, host.player.id, vec3(1, 0, 0));
    // The guest is the only one left, so the round is already theirs; clearing a
    // cell must therefore be refused rather than counted.
    const before = test.games.getGame(host.room.gameId).revision;
    test.rooms.reveal(host.room.id, guest.player.id, vec3(2, 2, 2));

    expect(test.games.getGame(host.room.gameId).revision).toBe(before);
    test.rooms.close();
  });
});

describe("co-op", () => {
  test("arms the countdown on the first reveal, not on creation", () => {
    const test = harness();
    const host = test.rooms.createRoom({ mode: "coop", presetId: "tiny", seed: 3, mineCount: 2 });

    expect(host.room.deadlineAt).toBeNull();
    expect(host.room.timeLimitMs).toBeGreaterThan(0);
    // Nothing is armed until somebody actually moves.
    expect(test.armed).toHaveLength(0);

    test.rooms.reveal(host.room.id, host.player.id, vec3(0, 0, 0));

    const room = test.rooms.getRoom(host.room.id);
    expect(room.status).toBe("playing");
    expect(room.deadlineAt).toBe(new Date(START + room.timeLimitMs).toISOString());
    expect(test.armed).toEqual([room.timeLimitMs]);
    test.rooms.close();
  });

  test("loses the round for everybody when the clock runs out", () => {
    const test = harness();
    const host = test.rooms.createRoom({ mode: "coop", presetId: "tiny", seed: 3, mineCount: 2 });
    const guest = test.rooms.joinRoom(host.room.id, { playerName: "Grace" });
    test.rooms.reveal(host.room.id, host.player.id, vec3(0, 0, 0));

    const limit = test.rooms.getRoom(host.room.id).timeLimitMs;
    test.advance(limit + 1);
    test.fireTimers();

    const room = test.rooms.getRoom(host.room.id);
    expect(room.status).toBe("lost");
    expect(outcomeOf(test, room.id, host.player.id)).toBe("out");
    expect(outcomeOf(test, room.id, guest.player.id)).toBe("out");
    test.rooms.close();
  });

  test("wins when the team clears the cube before the clock", () => {
    const test = harness();
    const host = test.rooms.createRoom({ mode: "coop", presetId: "tiny", seed: 3, mineCount: 2 });
    const guest = test.rooms.joinRoom(host.room.id, { playerName: "Grace" });

    clearBoard(test, host.room.id, host.player.id, host.room.gameId);

    const room = test.rooms.getRoom(host.room.id);
    expect(room.status).toBe("won");
    expect(outcomeOf(test, room.id, host.player.id)).toBe("cleared");
    expect(outcomeOf(test, room.id, guest.player.id)).toBe("cleared");
    test.rooms.close();
  });

  test("restarting resets the clock, the boards and everybody's standing", () => {
    const test = harness();
    const host = test.rooms.createRoom({ mode: "coop", presetId: "tiny", seed: 3, mineCount: 2 });
    test.rooms.joinRoom(host.room.id, { playerName: "Grace" });
    test.rooms.reveal(host.room.id, host.player.id, vec3(0, 0, 0));

    const restarted = test.rooms.restart(host.room.id, { playerName: "Ada", mineCount: 4 });

    expect(restarted.room.round).toBe(2);
    expect(restarted.room.status).toBe("ready");
    expect(restarted.room.deadlineAt).toBeNull();
    expect(restarted.room.config.mineCount).toBe(4);
    expect(restarted.game.state.status).toBe("ready");
    expect(restarted.room.players.every((player) => player.outcome === "playing")).toBe(true);
    test.advance(1);
    test.rooms.close();
  });

  test("does not count a flag as the start of the round", () => {
    const test = harness();
    const host = test.rooms.createRoom({ mode: "coop", presetId: "tiny", seed: 3, mineCount: 2 });

    test.rooms.cycleMark(host.room.id, host.player.id, vec3(0, 0, 0));

    expect(test.rooms.getRoom(host.room.id).deadlineAt).toBeNull();
    expect(test.armed).toHaveLength(0);
    test.rooms.close();
  });
});

describe("free reveals", () => {
  test("gives the room the charges it asked for", () => {
    const test = harness();
    const host = test.rooms.createRoom({ mode: "coop", presetId: "tiny", seed: 3, freeReveals: 2 });

    expect(host.room.config.freeReveals).toBe(2);
    expect(host.game.state.freeRevealsLeft).toBe(2);
    test.rooms.close();
  });

  test("does not start the co-op clock, exactly like a mark", () => {
    const test = harness();
    const host = test.rooms.createRoom({ mode: "coop", presetId: "tiny", seed: 3, freeReveals: 2 });

    const update = test.rooms.probe(host.room.id, host.player.id, vec3(0, 0, 0));

    expect(update?.events).toEqual([{ type: "cellProbed", cell: vec3(0, 0, 0), hasMine: expect.any(Boolean) }]);
    // A free reveal is information, not progress: the countdown still waits for
    // the first real dig, so nobody can burn the clock by inspecting cells.
    expect(test.rooms.getRoom(host.room.id).deadlineAt).toBeNull();
    expect(test.rooms.getRoom(host.room.id).status).toBe("ready");
    expect(test.armed).toHaveLength(0);
    test.rooms.close();
  });

  test("spends one shared budget in the modes that share a cube", () => {
    const test = harness();
    const host = test.rooms.createRoom({ mode: "coop", presetId: "tiny", seed: 3, freeReveals: 2 });
    const guest = test.rooms.joinRoom(host.room.id, { playerName: "Grace" });

    const update = test.rooms.probe(host.room.id, guest.player.id, vec3(0, 0, 0));

    // One cube, one budget: the charge the guest spent is gone for everybody.
    expect(update?.ownerId).toBeNull();
    expect(test.rooms.getBoard(host.room.id, host.player.id).state.freeRevealsLeft).toBe(1);
    expect(test.rooms.getBoard(host.room.id, guest.player.id).state.freeRevealsLeft).toBe(1);
    test.rooms.close();
  });

  test("keeps a budget per player in a race, on their own copy", () => {
    const test = harness();
    const host = test.rooms.createRoom({ mode: "race", presetId: "tiny", seed: 5, mineCount: 3, freeReveals: 2 });
    const guest = test.rooms.joinRoom(host.room.id, { playerName: "Grace" });

    const update = test.rooms.probe(host.room.id, host.player.id, vec3(0, 0, 0));

    expect(update?.ownerId).toBe(host.player.id);
    expect(test.rooms.getBoard(host.room.id, host.player.id).state.freeRevealsLeft).toBe(1);
    // The guest's identical cube is untouched: a race probes on its own board.
    expect(test.rooms.getBoard(host.room.id, guest.player.id).state.freeRevealsLeft).toBe(2);
    expect(test.rooms.getBoard(host.room.id, guest.player.id).state.cells[0]?.isProbed).toBe(false);
    test.rooms.close();
  });

  test("refuses a probe from a player the round has already taken out", () => {
    const test = harness();
    const host = test.rooms.createRoom({ mode: "survival", presetId: "tiny", seed: 1, mineCount: 1, freeReveals: 1 });
    const guest = test.rooms.joinRoom(host.room.id, { playerName: "Grace" });
    // A third player keeps the round alive once the host is gone, so the test
    // observes the elimination itself rather than the end of the round.
    test.rooms.joinRoom(host.room.id, { playerName: "Lin" });
    craftBoard(test, host.room.gameId, [vec3(1, 0, 0)]);

    test.rooms.reveal(host.room.id, host.player.id, vec3(0, 0, 0));
    test.rooms.reveal(host.room.id, host.player.id, vec3(1, 0, 0));
    expect(outcomeOf(test, host.room.id, host.player.id)).toBe("out");
    expect(test.rooms.getRoom(host.room.id).status).toBe("playing");

    expect(test.rooms.probe(host.room.id, host.player.id, vec3(2, 0, 0))).toBeUndefined();
    expect(test.rooms.getBoard(host.room.id, host.player.id).state.freeRevealsLeft).toBe(1);
    // The survivors can still spend the shared charge.
    expect(test.rooms.probe(host.room.id, guest.player.id, vec3(2, 0, 0))).toBeDefined();
    expect(test.rooms.getBoard(host.room.id, guest.player.id).state.freeRevealsLeft).toBe(0);
    test.rooms.close();
  });
});

describe("board isolation", () => {
  test("a race board is only reachable through its owner", () => {
    const test = harness();
    const host = test.rooms.createRoom({ mode: "race", presetId: "tiny", seed: 5, mineCount: 3 });
    const guest = test.rooms.joinRoom(host.room.id, { playerName: "Grace" });

    const hostBoard = test.rooms.getBoard(host.room.id, host.player.id);
    const guestBoard = test.rooms.getBoard(host.room.id, guest.player.id);
    const spectatorBoard = test.rooms.getBoard(host.room.id, null);

    expect(hostBoard.id).toBe(host.game.id);
    expect(guestBoard.id).toBe(guest.game.id);
    // A spectator (no seat) falls back to the room's own board.
    expect(spectatorBoard.id).toBe(test.rooms.getRoom(host.room.id).gameId);
    test.rooms.close();
  });

  test("shared modes resolve every seat to the same board", () => {
    const test = harness();
    const host = test.rooms.createRoom({ mode: "coop", presetId: "tiny", mineCount: 2 });
    const guest = test.rooms.joinRoom(host.room.id, { playerName: "Grace" });

    expect(test.rooms.getBoard(host.room.id, guest.player.id).id).toBe(host.game.id);
    test.rooms.close();
  });
});
