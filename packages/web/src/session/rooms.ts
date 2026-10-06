/**
 * Lobby client: the handful of HTTP calls the welcome screen needs.
 *
 * Rooms are pure server state, so this module is deliberately thin - it posts
 * to `/api/rooms` and validates the reply. Nothing is cached between calls:
 * reopening the lobby always shows the server's current truth.
 */
import { describeError, parseErrorMessage, parseRoomJoin, parseRoomList } from "./dto";
import type { RoomJoinDto, RoomSummaryDto } from "./dto";
import type { FetchLike } from "./remote";
import type { DifficultyId, MatchMode, RoomVisibility } from "@minesweeper3d/game-core";

/** Injectable side effects so the lobby can be tested without a network. */
export interface RoomClientOptions {
  /** Defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
  /** Origin of the API; empty means same origin. */
  readonly baseUrl?: string;
}

/** Options accepted when creating a room. */
export interface CreateRoomInput {
  readonly playerName?: string;
  readonly name?: string;
  readonly presetId?: string;
  /** How the room competes: together against the clock, a race, or survival. */
  readonly mode?: MatchMode;
  /**
   * Mines to place. The lobby sends the count the player actually chose, so the
   * tier the server reports back is derived from that count and can never
   * disagree with the board.
   */
  readonly mineCount?: number;
  /** Only used when no explicit `mineCount` is given. */
  readonly difficultyId?: DifficultyId;
  /**
   * Whether the lobby lists the room.
   *
   * Defaults to `"public"` on the server, so an empty body keeps the old
   * behaviour. A private room is unlisted, not locked: its code is the way in.
   */
  readonly visibility?: RoomVisibility;
  readonly firstRevealSafe?: boolean;
  /**
   * Charges for the free-reveal detector. Opt-in, so saying nothing grants
   * none; the engine rejects a count the board cannot use.
   */
  readonly freeReveals?: number;
}

/** Options accepted when joining a room. */
export interface JoinRoomInput {
  readonly playerName?: string;
  /** Seat to reclaim after a refresh or a direct link. */
  readonly playerId?: string;
}

/** The lobby API used by {@link WelcomeScreen}. */
export interface RoomClient {
  listRooms(): Promise<readonly RoomSummaryDto[]>;
  createRoom(input?: CreateRoomInput): Promise<RoomJoinDto>;
  joinRoom(roomId: string, input?: JoinRoomInput): Promise<RoomJoinDto>;
  leaveRoom(roomId: string, playerId: string): Promise<void>;
}

/** Creates a lobby client bound to an optional API origin. */
export function createRoomClient(options: RoomClientOptions = {}): RoomClient {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");

  return {
    async listRooms(): Promise<readonly RoomSummaryDto[]> {
      const response = await doFetch(`${baseUrl}/api/rooms`);
      const payload = await readJson(response);
      if (!response.ok) throw new Error(parseErrorMessage(payload) ?? `server responded with ${response.status}`);
      return parseRoomList(payload);
    },

    async createRoom(input: CreateRoomInput = {}): Promise<RoomJoinDto> {
      return postJoin(doFetch, `${baseUrl}/api/rooms`, {
        ...(input.playerName === undefined ? {} : { playerName: input.playerName }),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.presetId === undefined ? {} : { presetId: input.presetId }),
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        ...(input.mineCount === undefined ? {} : { mineCount: input.mineCount }),
        ...(input.difficultyId === undefined ? {} : { difficultyId: input.difficultyId }),
        ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
        ...(input.firstRevealSafe === undefined ? {} : { firstRevealSafe: input.firstRevealSafe }),
        ...(input.freeReveals === undefined ? {} : { freeReveals: input.freeReveals }),
      });
    },

    async joinRoom(roomId: string, input: JoinRoomInput = {}): Promise<RoomJoinDto> {
      return postJoin(doFetch, `${baseUrl}/api/rooms/${encodeURIComponent(roomId.trim().toUpperCase())}/join`, {
        ...(input.playerName === undefined ? {} : { playerName: input.playerName }),
        ...(input.playerId === undefined ? {} : { playerId: input.playerId }),
      });
    },

    async leaveRoom(roomId: string, playerId: string): Promise<void> {
      const response = await doFetch(`${baseUrl}/api/rooms/${encodeURIComponent(roomId)}/leave`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playerId }),
      });
      if (!response.ok) {
        const payload = await readJson(response);
        throw new Error(parseErrorMessage(payload) ?? `server responded with ${response.status}`);
      }
    },
  };
}

/** Turns a thrown lobby call into a message a player can act on. */
export function describeLobbyError(cause: unknown, fallback: string): string {
  return describeError(cause, fallback);
}

async function postJoin(doFetch: FetchLike, url: string, body: unknown): Promise<RoomJoinDto> {
  const response = await doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await readJson(response);
  if (!response.ok) throw new Error(parseErrorMessage(payload) ?? `server responded with ${response.status}`);
  return parseRoomJoin(payload);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
