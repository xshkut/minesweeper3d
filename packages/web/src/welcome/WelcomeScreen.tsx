/**
 * The welcome screen: shape the match, then create a room or join one.
 *
 * All room state lives on the server (in memory), so this screen is only a form:
 * it posts, validates the answer through the session DTOs, and hands the
 * resulting seat to the app. Listing rooms is best-effort - a lobby that cannot
 * be listed still allows creating and joining by code.
 *
 * The mine count is the one number the player actually chooses. The difficulty
 * word next to it is *derived* from that count and the cube's size, never stored
 * alongside it, so the indicator can never disagree with the board being played.
 */
import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import {
  DEFAULT_MATCH_MODE,
  DEFAULT_PRESET_ID,
  DEFAULT_ROOM_VISIBILITY,
  DIFFICULTIES,
  GAME_PRESETS,
  MATCH_MODES,
  ROOM_VISIBILITIES,
  cellCountOf,
  coopTimeLimitMs,
  defaultDifficultyForMode,
  difficultyOf,
  findPreset,
  formatDensity,
  matchModeInfo,
  maxMineCount,
  mineCountFor,
  mineCountForDensity,
  mineDensity,
} from "@minesweeper3d/game-core";
import type { MatchMode, RoomVisibility, Vec3 } from "@minesweeper3d/game-core";
import { describeLobbyError } from "../session/rooms";
import type { RoomClient } from "../session/rooms";
import { formatDuration } from "../session/summary";
import type { RoomJoinDto, RoomSummaryDto } from "../session/dto";

/** Props of {@link WelcomeScreen}. */
export interface WelcomeScreenProps {
  readonly client: RoomClient;
  /** Called with the seat once the server has accepted create/join. */
  readonly onEnter: (join: RoomJoinDto) => void;
  /** Code from `?room=` in the address bar, prefilled into the join field. */
  readonly initialCode?: string | null;
  /** Why an automatic join from the URL did not work; shown until the next try. */
  readonly initialError?: string | null;
}

const FALLBACK_SIZE: Vec3 = { x: 5, y: 5, z: 5 };

function sizeOf(presetId: string): Vec3 {
  return findPreset(presetId)?.size ?? FALLBACK_SIZE;
}

/**
 * Rescales a mine count when the cube changes: the same share of mines, which
 * keeps the difficulty word and the tier buttons where the player left them.
 */
function redistributed(from: Vec3, count: number, to: Vec3): number {
  const scaled = mineCountForDensity(to, mineDensity(from, count));
  return Math.min(maxMineCount(to), Math.max(1, scaled));
}

/**
 * Clamps a free-reveal charge count to what a board can actually spend: the
 * engine rejects a budget larger than the cell count, and a fractional or
 * negative one outright.
 */
function clampCharges(raw: number, max: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.min(max, Math.max(0, Math.trunc(raw)));
}

/** First screen of the app: pick a match, then play. */
export function WelcomeScreen({
  client,
  onEnter,
  initialCode = null,
  initialError = null,
}: WelcomeScreenProps): ReactElement {
  const [playerName, setPlayerName] = useState("");
  const [mode, setMode] = useState<MatchMode>(DEFAULT_MATCH_MODE);
  const [visibility, setVisibility] = useState<RoomVisibility>(DEFAULT_ROOM_VISIBILITY);
  const [presetId, setPresetId] = useState(DEFAULT_PRESET_ID);
  const [mineCount, setMineCount] = useState(() =>
    mineCountFor(sizeOf(DEFAULT_PRESET_ID), defaultDifficultyForMode(DEFAULT_MATCH_MODE)),
  );
  const [freeReveals, setFreeReveals] = useState(0);
  const [code, setCode] = useState(initialCode ?? "");
  const [rooms, setRooms] = useState<readonly RoomSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const name = playerName.trim() === "" ? "Player" : playerName.trim();
  const size = sizeOf(presetId);
  const maxMines = maxMineCount(size);
  const maxCharges = cellCountOf(size);
  const minMines = Math.min(1, maxMines);
  const difficulty = difficultyOf(size, mineCount);
  const modeInfo = matchModeInfo(mode);
  // A failed automatic join from the URL arrives as a prop, after the first
  // render; anything the player does here outranks it.
  const message = error ?? initialError;

  const refresh = useCallback(async () => {
    try {
      setRooms(await client.listRooms());
    } catch {
      // The list is a convenience; creating and joining by code still work.
      setRooms(null);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enter = useCallback(
    async (action: () => Promise<RoomJoinDto>, fallback: string) => {
      setBusy(true);
      setError(null);
      try {
        onEnter(await action());
      } catch (cause) {
        setError(describeLobbyError(cause, fallback));
        setBusy(false);
      }
    },
    [onEnter],
  );

  const handleMode = useCallback(
    (next: MatchMode) => {
      setMode(next);
      // Each mode recommends its own mine count (survival wants a thick cube);
      // the slider stays free afterwards.
      setMineCount(mineCountFor(size, defaultDifficultyForMode(next)));
    },
    [size],
  );

  const handlePreset = useCallback(
    (next: string) => {
      const nextSize = sizeOf(next);
      setPresetId(next);
      setMineCount((count) => redistributed(size, count, nextSize));
      // A smaller cube can no longer spend the budget the player picked.
      setFreeReveals((count) => Math.min(count, cellCountOf(nextSize)));
    },
    [size],
  );

  const handleCreate = useCallback(() => {
    void enter(
      () =>
        client.createRoom({
          playerName: name,
          presetId,
          mode,
          mineCount,
          visibility,
          ...(freeReveals === 0 ? {} : { freeReveals }),
        }),
      "Could not create the room",
    );
  }, [client, enter, freeReveals, mode, mineCount, name, presetId, visibility]);

  const handleJoin = useCallback(
    (roomCode: string) => {
      if (roomCode.trim() === "") {
        setError("Enter a room code first.");
        return;
      }
      void enter(() => client.joinRoom(roomCode, { playerName: name }), "Could not join the room");
    },
    [client, enter, name],
  );

  return (
    <main className="welcome" data-testid="welcome-screen">
      <div className="welcome__panel">
        <h1 className="welcome__title">
          Minesweeper<span>3D</span>
        </h1>
        <p className="welcome__lead">
          The cube lives on the server. Create a room and share its link, or join one that is already open.
        </p>

        <label className="field">
          <span className="field__label">Your name</span>
          <input
            className="field__control"
            data-testid="welcome-name"
            value={playerName}
            placeholder="Player"
            maxLength={24}
            onChange={(event) => setPlayerName(event.target.value)}
          />
        </label>

        <section className="welcome__section" aria-labelledby="welcome-create-heading">
          <h2 className="welcome__heading" id="welcome-create-heading">
            Create a room
          </h2>

          <div className="modes" data-testid="welcome-modes" role="group" aria-label="Match mode">
            {MATCH_MODES.map((option) => (
              <button
                key={option.id}
                type="button"
                className="modes__option"
                data-testid={`welcome-mode-${option.id}`}
                data-active={option.id === mode || undefined}
                aria-pressed={option.id === mode}
                disabled={busy}
                onClick={() => handleMode(option.id)}
              >
                <span className="modes__label">{option.label}</span>
                <span className="modes__tagline">{option.tagline}</span>
              </button>
            ))}
          </div>

          <div className="visibility" data-testid="welcome-visibility" role="group" aria-label="Room visibility">
            {ROOM_VISIBILITIES.map((option) => (
              <button
                key={option.id}
                type="button"
                className="visibility__option"
                data-testid={`welcome-visibility-${option.id}`}
                data-active={option.id === visibility || undefined}
                aria-pressed={option.id === visibility}
                disabled={busy}
                onClick={() => setVisibility(option.id)}
              >
                <span className="visibility__label">{option.label}</span>
                <span className="visibility__tagline">{option.tagline}</span>
              </button>
            ))}
          </div>

          <div className="welcome__row welcome__row--setup">
            <label className="field">
              <span className="field__label">Cube</span>
              <select
                className="field__control"
                data-testid="welcome-preset"
                value={presetId}
                onChange={(event) => handlePreset(event.target.value)}
              >
                {GAME_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label} — {preset.size.x}×{preset.size.y}×{preset.size.z}
                  </option>
                ))}
              </select>
            </label>

            <div className="mines">
              <div className="mines__head">
                <label className="field__label" htmlFor="welcome-mines">
                  Mines
                </label>
                <output className="mines__value" data-testid="welcome-mines-value" htmlFor="welcome-mines">
                  {mineCount}
                </output>
              </div>
              <input
                id="welcome-mines"
                className="mines__slider"
                data-testid="welcome-mines"
                type="range"
                min={minMines}
                max={maxMines}
                step={1}
                value={mineCount}
                disabled={busy}
                onChange={(event) => setMineCount(Number(event.target.value))}
              />
              <div className="mines__tiers" role="group" aria-label="Difficulty">
                {DIFFICULTIES.map((tier) => (
                  <button
                    key={tier.id}
                    type="button"
                    className="mines__tier"
                    data-testid={`welcome-tier-${tier.id}`}
                    data-active={tier.id === difficulty.id || undefined}
                    aria-pressed={tier.id === difficulty.id}
                    disabled={busy}
                    onClick={() => setMineCount(mineCountFor(size, tier.id))}
                  >
                    {tier.label}
                  </button>
                ))}
              </div>
              <p className="mines__readout">
                <span
                  className="mines__badge"
                  data-testid="welcome-difficulty"
                  data-difficulty={difficulty.id}
                >
                  {difficulty.label}
                </span>
                <span className="mines__density" data-testid="welcome-density">
                  {formatDensity(size, mineCount)}
                </span>
              </p>
            </div>

            <label className="field">
              <span className="field__label">Free reveals</span>
              <input
                className="field__control"
                data-testid="welcome-free-reveals"
                type="number"
                min={0}
                max={maxCharges}
                step={1}
                value={freeReveals}
                disabled={busy}
                onChange={(event) => setFreeReveals(clampCharges(Number(event.target.value), maxCharges))}
              />
              <span className="field__hint">
                Charges that tell you whether a covered cell hides a bomb. 0 turns the aid off.
              </span>
            </label>
          </div>

          <p className="welcome__muted" data-testid="welcome-match-note">
            {modeInfo.id === "coop"
              ? `Players versus the clock: ${formatDuration(coopTimeLimitMs(size, mineCount))} to clear the cube together.`
              : modeInfo.id === "race"
                ? "Everyone gets the same cube. The first player to disarm it wins."
                : "Step on a mine and you are out. The last player still digging wins."}
          </p>

          <button
            type="button"
            className="button button--primary"
            data-testid="welcome-create"
            disabled={busy}
            onClick={handleCreate}
          >
            {visibility === "private" ? "Create private room" : "Create room"}
          </button>
        </section>

        <section className="welcome__section" aria-labelledby="welcome-join-heading">
          <h2 className="welcome__heading" id="welcome-join-heading">
            Join a room
          </h2>
          <div className="welcome__row">
            <label className="field">
              <span className="field__label">Room code</span>
              <input
                className="field__control"
                data-testid="welcome-code"
                value={code}
                placeholder="K7QP2M4XZB"
                maxLength={16}
                onChange={(event) => setCode(event.target.value.replace(/\s+/g, "").toUpperCase())}
              />
            </label>
            <button
              type="button"
              className="button"
              data-testid="welcome-join"
              disabled={busy}
              onClick={() => handleJoin(code)}
            >
              Join
            </button>
          </div>

          <div className="welcome__rooms">
            <div className="welcome__rooms-head">
              <span className="field__label">Open rooms</span>
              <button
                type="button"
                className="button button--ghost"
                data-testid="welcome-refresh"
                onClick={() => void refresh()}
              >
                Refresh
              </button>
            </div>
            {rooms === null || rooms.length === 0 ? (
              <p className="welcome__muted" data-testid="welcome-rooms-empty">
                {rooms === null ? "No rooms to list." : "No rooms yet — create the first one."}
              </p>
            ) : (
              <ul className="welcome__list" data-testid="welcome-rooms">
                {rooms.map((room) => (
                  <li key={room.id} className="welcome__room">
                    <button
                      type="button"
                      className="button button--ghost welcome__room-button"
                      data-testid={`welcome-room-${room.id}`}
                      disabled={busy}
                      onClick={() => handleJoin(room.id)}
                    >
                      <span className="welcome__room-code">{room.id}</span>
                      <span className="welcome__room-meta">
                        {matchModeInfo(room.mode).label} · {room.difficultyLabel} · {room.mineCount} mines ·{" "}
                        {room.playerCount}/{room.maxPlayers} · {room.status}
                      </span>
                      <span className="welcome__muted">{room.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {message !== null && (
          <p className="welcome__error" role="alert" data-testid="welcome-error">
            {message}
          </p>
        )}
      </div>
    </main>
  );
}
