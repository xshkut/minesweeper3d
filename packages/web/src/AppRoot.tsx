/**
 * Root: decides between the welcome screen and the game.
 *
 * The default mode is `remote`, which starts in the lobby so a room can be
 * created or joined; `?mode=local` skips the lobby and plays offline. The
 * session is owned here so leaving a room can dispose it and drop the player
 * from the server.
 *
 * This is also where a room code becomes a URL: entering a room writes
 * `?room=CODE` into the address bar, leaving clears it, opening a link with the
 * parameter joins automatically, and the browser's back button walks between the
 * two. The browser remembers the player's name and their seat in each room
 * ({@link createIdentity}) so a refresh reclaims the seat instead of sitting
 * down as somebody new.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { App } from "./App";
import { createLocalSession } from "./session/local";
import { createRemoteSession } from "./session/remote";
import type { RemoteSessionDeps } from "./session/remote";
import { createRoomClient, describeLobbyError } from "./session/rooms";
import type { RoomClient } from "./session/rooms";
import { createIdentity } from "./session/identity";
import type { Identity } from "./session/identity";
import { currentRoomParam, onRoomParamChange, readRoomParam, setRoomInLocation } from "./session/url";
import { installAutomationHook } from "./session/store";
import { parseSessionMode } from "./session/types";
import type { GameSession, SessionMode, SessionSnapshot } from "./session/types";
import type { RoomJoinDto } from "./session/dto";
import { WelcomeScreen } from "./welcome/WelcomeScreen";

/** Props of {@link AppRoot}. */
export interface AppRootProps {
  /** Overrides the mode read from the URL. */
  readonly mode?: SessionMode;
  /** Query string to read the mode from; defaults to the current location. */
  readonly search?: string;
  /** Injectable network primitives for the remote session and lobby (tests). */
  readonly deps?: RemoteSessionDeps;
  /** Overrides the lobby client (tests). */
  readonly client?: RoomClient;
  /** Overrides remembered name/seat storage (tests). */
  readonly identity?: Identity;
}

/** Application root; `main.tsx` only mounts this. */
export function AppRoot({ mode, search, deps, client, identity }: AppRootProps): ReactElement {
  const initialSearch = search ?? currentSearch();
  const resolvedMode = mode ?? parseSessionMode(initialSearch);
  // A local game has no room, so a `?room=` alongside `?mode=local` is ignored.
  const initialRoom = resolvedMode === "local" ? null : readRoomParam(initialSearch);

  const [session, setSession] = useState<GameSession | null>(() =>
    resolvedMode === "local" ? createLocalSession() : null,
  );
  const [lobbyError, setLobbyError] = useState<string | null>(null);

  const sessionRef = useRef<GameSession | null>(session);
  sessionRef.current = session;

  const lobby = useMemo(
    () =>
      client ??
      createRoomClient({
        ...(deps?.fetch === undefined ? {} : { fetch: deps.fetch }),
        ...(deps?.baseUrl === undefined ? {} : { baseUrl: deps.baseUrl }),
      }),
    [client, deps?.fetch, deps?.baseUrl],
  );
  const lobbyRef = useRef(lobby);
  lobbyRef.current = lobby;

  const depsRef = useRef(deps);
  depsRef.current = deps;

  const identityStore = useMemo(() => identity ?? createIdentity(), [identity]);
  const identityRef = useRef(identityStore);
  identityRef.current = identityStore;

  const enter = useCallback((join: RoomJoinDto, options: { replace?: boolean } = {}) => {
    const next = createRemoteSession({
      room: join,
      ...(depsRef.current === undefined ? {} : { deps: depsRef.current }),
    });
    sessionRef.current?.dispose();
    sessionRef.current = next;
    setSession(next);
    identityRef.current.rememberSeat(join.room.id, join.player.id);
    identityRef.current.rememberName(join.player.name);
    setRoomInLocation(join.room.id, options.replace === true ? { replace: true } : {});
    setLobbyError(null);
  }, []);
  const enterRef = useRef(enter);
  enterRef.current = enter;

  /** Joins a room by code, reclaiming this browser's seat when it has one. */
  const joinByCode = useCallback(async (roomId: string, options: { replace?: boolean } = {}) => {
    const seat = identityRef.current.seat(roomId);
    const playerName = identityRef.current.name();
    try {
      const join = await lobbyRef.current.joinRoom(roomId, {
        ...(playerName === null ? {} : { playerName }),
        ...(seat === null ? {} : { playerId: seat }),
      });
      enterRef.current(join, options);
    } catch (cause) {
      setLobbyError(describeLobbyError(cause, `Could not join room ${roomId}`));
    }
  }, []);
  const joinByCodeRef = useRef(joinByCode);
  joinByCodeRef.current = joinByCode;

  const handleLeave = useCallback(async () => {
    const snapshot: SessionSnapshot | undefined = sessionRef.current?.getSnapshot();
    const room = snapshot?.room ?? null;
    const playerId = snapshot?.playerId;
    sessionRef.current?.dispose();
    sessionRef.current = null;
    setSession(null);
    if (room !== null) {
      identityRef.current.forgetSeat(room.id);
      setRoomInLocation(null, { replace: true });
    }
    if (room !== null && playerId !== undefined) {
      try {
        await lobbyRef.current.leaveRoom(room.id, playerId);
      } catch {
        // Leaving locally must always succeed; the server prunes the room anyway.
      }
    }
  }, []);
  const leaveRef = useRef(handleLeave);
  leaveRef.current = handleLeave;

  // React's StrictMode mounts effects twice in development. The generation
  // counter keeps the first cleanup from disposing a session that is still in
  // use after the immediate remount.
  const mountGeneration = useRef(0);
  useEffect(() => {
    mountGeneration.current += 1;
    const mine = mountGeneration.current;
    return () => {
      queueMicrotask(() => {
        if (mountGeneration.current === mine) {
          sessionRef.current?.dispose();
          sessionRef.current = null;
        }
      });
    };
  }, []);

  // Arriving with `?room=CODE` in the address bar is an invitation: join it.
  // A shared link is what replaces "read me the code out loud".
  useEffect(() => {
    if (initialRoom === null || sessionRef.current !== null) return;
    void joinByCodeRef.current(initialRoom, { replace: true });
  }, [initialRoom]);

  // Back and forward move between the lobby and the room the URL names.
  useEffect(
    () =>
      onRoomParamChange(() => {
        const roomId = currentRoomParam();
        const current = sessionRef.current?.getSnapshot().room ?? null;
        if (roomId === null) {
          if (sessionRef.current !== null) void leaveRef.current();
          return;
        }
        if (current?.id === roomId) return;
        if (sessionRef.current !== null) sessionRef.current.dispose();
        sessionRef.current = null;
        setSession(null);
        void joinByCodeRef.current(roomId, { replace: true });
      }),
    [],
  );

  useEffect(
    () =>
      installAutomationHook({
        getSession: () => sessionRef.current,
        createRoom: async (options) => {
          const join = await lobbyRef.current.createRoom({
            ...(options?.playerName === undefined ? {} : { playerName: options.playerName }),
            ...(options?.presetId === undefined ? {} : { presetId: options.presetId }),
            ...(options?.mode === undefined ? {} : { mode: options.mode }),
            ...(options?.mineCount === undefined ? {} : { mineCount: options.mineCount }),
            ...(options?.visibility === undefined ? {} : { visibility: options.visibility }),
            ...(options?.freeReveals === undefined ? {} : { freeReveals: options.freeReveals }),
          });
          enterRef.current(join);
          return join;
        },
        joinRoom: async (roomId, options) => {
          const join = await lobbyRef.current.joinRoom(roomId, {
            ...(options?.playerName === undefined ? {} : { playerName: options.playerName }),
          });
          enterRef.current(join);
          return join;
        },
      }),
    [],
  );

  if (session === null) {
    return <WelcomeScreen client={lobby} onEnter={enter} initialCode={initialRoom} initialError={lobbyError} />;
  }

  return <App session={session} onLeave={() => void handleLeave()} />;
}

function currentSearch(): string {
  return typeof location === "undefined" ? "" : location.search;
}
