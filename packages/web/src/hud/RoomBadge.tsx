/**
 * Room panel: what is being played, who is seated, and the way back to the lobby.
 *
 * Presence and outcome both come from the server, including the "away" state of
 * a player whose tab closed - the board stays theirs even while they are
 * disconnected. The one thing computed here is the co-op countdown: the server
 * owns the deadline, and this only renders the time left until it.
 */
import type { ReactElement } from "react";
import { matchModeInfo, roomVisibilityInfo } from "@minesweeper3d/game-core";
import type { GameStatus, MatchMode } from "@minesweeper3d/game-core";
import { formatDuration } from "../session/summary";
import { playerColor } from "../session/presence";
import type { PlayerDto, RoomDto } from "../session/dto";

/** Props of {@link RoomBadge}. */
export interface RoomBadgeProps {
  readonly room: RoomDto | null;
  readonly playerId: string | null;
  readonly onLeave?: (() => void) | undefined;
  /** Injectable clock, so the countdown can be tested. */
  readonly now?: (() => number) | undefined;
}

const OUTCOME_LABEL: Record<PlayerDto["outcome"], string> = {
  playing: "",
  cleared: "cleared",
  out: "out",
};

/** Renders nothing outside a room. */
export function RoomBadge({ room, playerId, onLeave, now = Date.now }: RoomBadgeProps): ReactElement | null {
  if (room === null) return null;

  const mode = matchModeInfo(room.mode);
  const visibility = roomVisibilityInfo(room.visibility);
  const winner = room.players.find((player) => player.outcome === "cleared") ?? null;
  const remaining =
    room.deadlineAt === null ? null : Math.max(0, Date.parse(room.deadlineAt) - now());
  const showClock = mode.id === "coop" && room.status === "playing" && remaining !== null;

  return (
    <section className="room" data-testid="room-badge" data-room={room.id} data-mode={room.mode}>
      <div className="room__head">
        <span className="room__label">Room</span>
        <span className="room__code" data-testid="room-code">
          {room.id}
        </span>
        {visibility.id === "private" && (
          <span
            className="room__visibility"
            data-testid="room-visibility"
            data-visibility={visibility.id}
            title={visibility.tagline}
          >
            {visibility.label}
          </span>
        )}
        <span className="room__mode" data-testid="room-mode" data-mode={room.mode}>
          {mode.label}
        </span>
      </div>
      {room.name !== "" && <p className="room__name">{room.name}</p>}

      <dl className="room__setup">
        <div className="room__stat">
          <dt>Board</dt>
          <dd data-testid="room-board">
            {room.size.x}×{room.size.y}×{room.size.z}
          </dd>
        </div>
        <div className="room__stat">
          <dt>Mines</dt>
          <dd data-testid="room-mines">
            {room.mineCount}
            <span className="room__tier" data-testid="room-difficulty" data-difficulty={room.difficultyId}>
              {room.difficultyLabel}
            </span>
          </dd>
        </div>
        <div className="room__stat">
          <dt>Round</dt>
          <dd data-testid="room-round">{room.round}</dd>
        </div>
        {room.freeReveals > 0 && (
          <div className="room__stat">
            <dt>Free reveals</dt>
            <dd data-testid="room-free-reveals">{room.freeReveals}</dd>
          </div>
        )}
      </dl>

      {showClock && (
        <p className="room__clock" data-testid="room-clock">
          <span className="room__clock-label">Time left</span>
          <span className="room__clock-value">{formatDuration(remaining)}</span>
        </p>
      )}

      <ul className="room__players" data-testid="room-players">
        {room.players.map((player) => (
          <li
            key={player.id}
            className="room__player"
            data-connected={player.connected}
            data-self={player.id === playerId}
            data-outcome={player.outcome}
          >
            <span
              className="room__swatch"
              data-testid={`room-swatch-${player.id}`}
              // The colour is also written out as data, because it is the same
              // one their pointer is drawn in on the board and a test pins the
              // two together.
              data-player-color={playerColor(player.id)}
              style={{ backgroundColor: playerColor(player.id) }}
              aria-hidden="true"
            />
            <span className={`room__dot${player.connected ? " room__dot--ok" : ""}`} aria-hidden="true" />
            <span className="room__player-name">{player.name}</span>
            {player.id === playerId ? <span className="room__you">(you)</span> : null}
            {player.outcome !== "playing" && (
              <span className={`room__outcome room__outcome--${player.outcome}`} data-testid={`room-outcome-${player.id}`}>
                {OUTCOME_LABEL[player.outcome]}
              </span>
            )}
            {player.revealedCount > 0 && <span className="room__score">{player.revealedCount}</span>}
          </li>
        ))}
      </ul>

      {room.status !== "ready" && room.status !== "playing" && (
        <p className="room__result" data-testid="room-result" data-status={room.status}>
          {describeResult(room.status, mode.id, winner)}
        </p>
      )}

      {onLeave !== undefined && (
        <button type="button" className="button button--ghost room__leave" data-testid="leave-room" onClick={onLeave}>
          Leave room
        </button>
      )}
    </section>
  );
}

function describeResult(status: GameStatus, mode: MatchMode, winner: PlayerDto | null): string {
  const name = winner?.name ?? "nobody";
  if (status === "won") {
    if (mode === "race") return `${name} disarmed the cube first.`;
    if (mode === "survival") return `${name} is still digging.`;
    return "Cube disarmed. The clock did not beat you.";
  }
  if (mode === "coop") return "The clock beat you.";
  if (mode === "survival") return "Everyone stepped on a mine.";
  return "Nobody disarmed the cube.";
}
