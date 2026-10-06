/**
 * Shared fixtures for the room contract.
 *
 * The DTOs grow as the game does, and three test files build rooms and players
 * by hand. Keeping the defaults in one place means a new field is added once and
 * every test keeps typechecking, instead of each test drifting on its own.
 */
import type { ClientGameState, GameConfig } from "@minesweeper3d/game-core";
import type { PlayerDto, RoomDto, RoomJoinDto, RoomSummaryDto } from "../session/dto";

const CREATED_AT = "2026-01-01T00:00:00.000Z";

/** A valid config; every board fixture is built from it. */
export function testConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    size: { x: 3, y: 3, z: 3 },
    mineCount: 3,
    seed: 1,
    firstRevealSafe: true,
    minesFatal: true,
    freeReveals: 0,
    ...overrides,
  };
}

/** A minimal valid client state; tests that never look at cells use this. */
export function testState(overrides: Partial<ClientGameState> = {}): ClientGameState {
  return {
    config: testConfig(),
    status: "ready",
    cells: [],
    revealedCount: 0,
    flagCount: 0,
    freeRevealsLeft: 0,
    explodedAt: null,
    ...overrides,
  };
}

/** A seated player, playing their round unless told otherwise. */
export function testPlayer(overrides: Partial<PlayerDto> = {}): PlayerDto {
  return {
    id: "p1",
    name: "Ada",
    joinedAt: CREATED_AT,
    connected: true,
    outcome: "playing",
    finishedAt: null,
    revealedCount: 0,
    ...overrides,
  };
}

/** A room playing a 3x3x3 cube with three mines. */
export function testRoom(overrides: Partial<RoomDto> = {}): RoomDto {
  return {
    id: "ROOM01",
    name: "Ada's room",
    gameId: "game-1",
    mode: "coop",
    visibility: "public",
    status: "ready",
    round: 1,
    presetId: "tiny",
    difficultyId: "normal",
    difficultyLabel: "Normal",
    mineCount: 3,
    size: { x: 3, y: 3, z: 3 },
    freeReveals: 0,
    players: [testPlayer()],
    maxPlayers: 8,
    deadlineAt: null,
    timeLimitMs: 0,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

/** A room as the lobby list shows it. */
export function testSummary(overrides: Partial<RoomSummaryDto> = {}): RoomSummaryDto {
  return {
    id: "ROOM01",
    name: "Ada's room",
    gameId: "game-1",
    mode: "coop",
    visibility: "public",
    status: "ready",
    round: 1,
    presetId: "tiny",
    difficultyId: "normal",
    difficultyLabel: "Normal",
    mineCount: 3,
    size: { x: 3, y: 3, z: 3 },
    freeReveals: 0,
    playerCount: 1,
    maxPlayers: 8,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

/** The payload of a create/join, with a real board unless one is supplied. */
export function testJoin(overrides: Partial<RoomJoinDto> = {}): RoomJoinDto {
  return {
    room: testRoom(),
    player: testPlayer(),
    game: { id: "game-1", revision: 0, createdAt: CREATED_AT, updatedAt: CREATED_AT, state: testState() },
    ...overrides,
  };
}
