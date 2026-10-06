/**
 * Root test: the lobby-to-game transition is exercised with a fake `RoomClient`
 * and a fake socket, so the default server-side mode can be tested offline.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createGame, presetConfig, toClientView } from "@minesweeper3d/game-core";

mock.module("@react-three/fiber", () => ({
  Canvas: () => React.createElement("canvas", { "data-testid": "canvas-mock" }),
  useFrame: () => null,
  useThree: () => ({ gl: { domElement: { style: {} } }, camera: {}, scene: {} }),
  useLoader: () => {
    throw new Error("assets are not loaded in unit tests");
  },
}));

const { AppRoot } = await import("./AppRoot");
const { createRoomClient } = await import("./session/rooms");
const { createIdentity } = await import("./session/identity");
import type { Identity, IdentityStorage } from "./session/identity";
import type { RoomClient } from "./session/rooms";
import type { SocketLike } from "./session/remote";
import type { RoomJoinDto, RoomSummaryDto } from "./session/dto";
import { testPlayer, testRoom, testSummary } from "./test/fixtures";

afterEach(() => {
  cleanup();
  delete window.__minesweeper3d;
  // The URL is part of the app state under test, so every test starts clean.
  window.history.replaceState({}, "", "/");
  // So is the remembered name/seat: the default identity reads real storage.
  window.localStorage.clear();
});

const ROOM_ID = "ROOM01";

const SUMMARY: RoomSummaryDto = testSummary({ id: ROOM_ID });

function joinDto(): RoomJoinDto {
  return {
    room: testRoom({ id: ROOM_ID }),
    player: testPlayer(),
    game: {
      id: "game-1",
      revision: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      state: toClientView(createGame(presetConfig("tiny", { seed: 5 }))),
    },
  };
}

/** A socket that records nothing; the AppRoot test never plays a move. */
class FakeSocket implements SocketLike {
  onOpen: (() => void) | null = null;
  onMessage: ((data: string) => void) | null = null;
  onClose: (() => void) | null = null;
  onError: ((error: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(): void {}
  close(): void {}
}

/** In-memory `localStorage`, so the seat-reclaim path is testable. */
function fakeStorage(seed: Record<string, string> = {}): IdentityStorage & { readonly values: Map<string, string> } {
  const values = new Map(Object.entries(seed));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

interface LobbySpy {
  readonly client: RoomClient;
  readonly left: { roomId: string; playerId: string }[];
  readonly joined: { roomId: string; playerName?: string | undefined; playerId?: string | undefined }[];
}

function lobbySpy(): LobbySpy {
  const left: { roomId: string; playerId: string }[] = [];
  const joined: { roomId: string; playerName?: string | undefined; playerId?: string | undefined }[] = [];
  const client = createRoomClient({
    fetch: async () => new Response(JSON.stringify({ rooms: [SUMMARY] }), { headers: { "content-type": "application/json" } }),
    baseUrl: "http://lobby.test",
  });
  return {
    client: {
      ...client,
      listRooms: async () => [SUMMARY],
      createRoom: async () => joinDto(),
      joinRoom: async (roomId, input) => {
        joined.push({ roomId, playerName: input?.playerName, playerId: input?.playerId });
        return joinDto();
      },
      leaveRoom: async (roomId, playerId) => {
        left.push({ roomId, playerId });
      },
    },
    left,
    joined,
  };
}

function deps() {
  return {
    baseUrl: "http://lobby.test",
    openSocket: (url: string) => new FakeSocket(url),
  };
}

describe("AppRoot", () => {
  test("starts in the lobby by default", async () => {
    const spy = lobbySpy();
    render(<AppRoot client={spy.client} deps={deps()} />);

    expect(screen.getByTestId("welcome-screen")).toBeDefined();
    expect(screen.queryByTestId("hud-status")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("welcome-rooms")).toBeDefined());
  });

  test("?mode=local skips the lobby", () => {
    render(<AppRoot mode="local" />);

    expect(screen.queryByTestId("welcome-screen")).toBeNull();
    expect(screen.getByTestId("hud-status").textContent).toBe("Ready");
  });

  test("creating a room swaps the lobby for the shared board", async () => {
    const spy = lobbySpy();
    render(<AppRoot client={spy.client} deps={deps()} />);
    await waitFor(() => expect(screen.getByTestId("welcome-rooms")).toBeDefined());

    fireEvent.click(screen.getByTestId("welcome-create"));

    await waitFor(() => expect(screen.getByTestId("hud-status")).toBeDefined());
    expect(screen.queryByTestId("welcome-screen")).toBeNull();
    expect(screen.getByTestId("room-code").textContent).toBe(ROOM_ID);
    expect(screen.getByTestId("canvas-mock")).toBeDefined();
  });

  test("the automation hook can create a room", async () => {
    const spy = lobbySpy();
    render(<AppRoot client={spy.client} deps={deps()} />);

    await act(async () => {
      await window.__minesweeper3d?.createRoom({ playerName: "Ada", presetId: "tiny" });
    });

    await waitFor(() => expect(screen.getByTestId("hud-status")).toBeDefined());
    expect(window.__minesweeper3d?.snapshot().room?.id).toBe(ROOM_ID);
  });

  test("leaving the room returns to the lobby and tells the server", async () => {
    const spy = lobbySpy();
    render(<AppRoot client={spy.client} deps={deps()} />);
    fireEvent.click(screen.getByTestId("welcome-create"));
    await waitFor(() => expect(screen.getByTestId("room-badge")).toBeDefined());

    fireEvent.click(screen.getByTestId("leave-room"));

    await waitFor(() => expect(screen.getByTestId("welcome-screen")).toBeDefined());
    expect(spy.left).toEqual([{ roomId: ROOM_ID, playerId: "p1" }]);
    expect(window.__minesweeper3d?.snapshot().state).toBeNull();
  });

  test("puts the room code in the URL while playing and clears it on leave", async () => {
    const spy = lobbySpy();
    render(<AppRoot client={spy.client} deps={deps()} />);
    await waitFor(() => expect(screen.getByTestId("welcome-rooms")).toBeDefined());

    expect(window.location.search).toBe("");

    fireEvent.click(screen.getByTestId("welcome-create"));
    await waitFor(() => expect(screen.getByTestId("room-badge")).toBeDefined());
    expect(window.location.search).toBe(`?room=${ROOM_ID}`);

    fireEvent.click(screen.getByTestId("leave-room"));
    await waitFor(() => expect(screen.getByTestId("welcome-screen")).toBeDefined());
    expect(window.location.search).toBe("");
  });

  test("a ?room= link joins that room on load", async () => {
    const spy = lobbySpy();
    render(<AppRoot client={spy.client} deps={deps()} search={`?room=${ROOM_ID}`} />);

    await waitFor(() => expect(screen.getByTestId("room-badge")).toBeDefined());
    // No remembered name yet, so the server picks the default one.
    expect(spy.joined).toEqual([{ roomId: ROOM_ID, playerName: undefined, playerId: undefined }]);
  });

  test("a stored seat is reclaimed instead of seating a ghost", async () => {
    const spy = lobbySpy();
    const identity: Identity = createIdentity(fakeStorage({ [`minesweeper3d:seat:${ROOM_ID}`]: "p9", "minesweeper3d:name": "Ada" }));
    render(<AppRoot client={spy.client} deps={deps()} search={`?room=${ROOM_ID}`} identity={identity} />);

    await waitFor(() => expect(spy.joined).toHaveLength(1));
    expect(spy.joined[0]).toEqual({ roomId: ROOM_ID, playerName: "Ada", playerId: "p9" });
  });

  test("a reload of a room link reuses the seat the first join stored", async () => {
    const spy = lobbySpy();
    const storage = fakeStorage();
    const identity: Identity = createIdentity(storage);

    const first = render(<AppRoot client={spy.client} deps={deps()} identity={identity} />);
    await waitFor(() => expect(screen.getByTestId("welcome-rooms")).toBeDefined());
    fireEvent.click(screen.getByTestId("welcome-create"));
    await waitFor(() => expect(screen.getByTestId("room-badge")).toBeDefined());
    first.unmount();

    expect(storage.values.get(`minesweeper3d:seat:${ROOM_ID}`)).toBe("p1");
    expect(window.location.search).toBe(`?room=${ROOM_ID}`);
  });
});
