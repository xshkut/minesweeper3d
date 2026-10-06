/**
 * Wire shapes of the rooms API.
 *
 * A room is always serialised together with the board the caller plays on, and
 * every game goes through `toGameDto`, i.e. `toClientView`. Mines and covered
 * danger counts therefore never leave the server just because a room asked for
 * the state.
 *
 * The mine tier is derived here rather than stored: `config.mineCount` is the
 * truth, and a tier that disagreed with it would be a lie the lobby shows.
 */
import { difficultyOf } from "@minesweeper3d/game-core";
import type { MatchMode, MatchStatus, RoomVisibility, Vec3 } from "@minesweeper3d/game-core";
import type { PlayerOutcome, PlayerRecord, RoomRecord } from "./store";

/** A player as clients see them: identity, derived presence and round standing. */
export interface PlayerDto {
  readonly id: string;
  readonly name: string;
  readonly joinedAt: string;
  /** `true` while the player has at least one open socket. */
  readonly connected: boolean;
  readonly outcome: PlayerOutcome;
  readonly finishedAt: string | null;
  readonly revealedCount: number;
}

/** A full room: the match, its rules and its players. */
export interface RoomDto {
  readonly id: string;
  readonly name: string;
  readonly mode: MatchMode;
  /** `"private"` rooms are missing from the lobby list but still joinable by code. */
  readonly visibility: RoomVisibility;
  /** How the round as a whole is going; `ClientGameState["status"]` is the board. */
  readonly status: MatchStatus;
  readonly round: number;
  readonly presetId: string;
  /** Mine tier, derived from the board's density. */
  readonly difficultyId: string;
  readonly difficultyLabel: string;
  readonly mineCount: number;
  readonly size: Vec3;
  /** Charges the free-reveal aid grants; `0` when the aid is off. */
  readonly freeReveals: number;
  /** Co-op only: when the countdown ends; `null` before the first reveal. */
  readonly deadlineAt: string | null;
  readonly timeLimitMs: number;
  readonly gameId: string;
  readonly players: readonly PlayerDto[];
  readonly maxPlayers: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A room in the join list. */
export interface RoomSummaryDto {
  readonly id: string;
  readonly name: string;
  readonly mode: MatchMode;
  /** Always `"public"` today: the lobby only ever lists listed rooms. */
  readonly visibility: RoomVisibility;
  readonly playerCount: number;
  readonly maxPlayers: number;
  readonly status: MatchStatus;
  readonly presetId: string;
  readonly difficultyId: string;
  readonly difficultyLabel: string;
  readonly mineCount: number;
  readonly size: Vec3;
  /** Charges the free-reveal aid grants; `0` when the aid is off. */
  readonly freeReveals: number;
  readonly round: number;
  readonly createdAt: string;
}

/** Presence is derived, never stored as a flag. */
export function toPlayerDto(player: PlayerRecord): PlayerDto {
  return {
    id: player.id,
    name: player.name,
    joinedAt: player.joinedAt,
    connected: player.connections > 0,
    outcome: player.outcome,
    finishedAt: player.finishedAt,
    revealedCount: player.revealedCount,
  };
}

/** Serialises a room with its players. */
export function toRoomDto(room: RoomRecord): RoomDto {
  const difficulty = difficultyOf(room.config.size, room.config.mineCount);
  return {
    id: room.id,
    name: room.name,
    mode: room.mode,
    visibility: room.visibility,
    status: room.status,
    round: room.round,
    presetId: room.presetId,
    difficultyId: difficulty.id,
    difficultyLabel: difficulty.label,
    mineCount: room.config.mineCount,
    size: room.config.size,
    freeReveals: room.config.freeReveals,
    deadlineAt: room.deadlineAt,
    timeLimitMs: room.timeLimitMs,
    gameId: room.gameId,
    players: room.players.map(toPlayerDto),
    maxPlayers: room.maxPlayers,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  };
}

/** Serialises the compact form shown on the welcome screen. */
export function toRoomSummaryDto(room: RoomRecord): RoomSummaryDto {
  const difficulty = difficultyOf(room.config.size, room.config.mineCount);
  return {
    id: room.id,
    name: room.name,
    mode: room.mode,
    visibility: room.visibility,
    playerCount: room.players.length,
    maxPlayers: room.maxPlayers,
    status: room.status,
    presetId: room.presetId,
    difficultyId: difficulty.id,
    difficultyLabel: difficulty.label,
    mineCount: room.config.mineCount,
    size: room.config.size,
    freeReveals: room.config.freeReveals,
    round: room.round,
    createdAt: room.createdAt,
  };
}
