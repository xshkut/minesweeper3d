/**
 * Wire representation of a game.
 *
 * The DTO is the only shape clients ever see: the engine's `GameState` is
 * redacted through `toClientView`, so a player can never read the mine layout
 * out of a response (or out of a WebSocket frame) while the game is running.
 */
import { toClientView } from "@minesweeper3d/game-core";
import type { ClientGameState } from "@minesweeper3d/game-core";
import type { StoredGame } from "./store";

/** A game as sent to clients: identity, revision and redacted state. */
export interface GameDto {
  readonly id: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: ClientGameState;
}

/** Maps a stored game to its wire form. */
export function toGameDto(game: StoredGame): GameDto {
  return {
    id: game.id,
    revision: game.revision,
    createdAt: game.createdAt,
    updatedAt: game.updatedAt,
    state: toClientView(game.state),
  };
}
