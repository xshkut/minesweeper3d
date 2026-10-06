/**
 * Welcome screen test: the lobby form is exercised with a fake `RoomClient`,
 * so no network and no WebGL are involved.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WelcomeScreen } from "./WelcomeScreen";
import type { RoomClient } from "../session/rooms";
import type { RoomJoinDto, RoomSummaryDto } from "../session/dto";
import { mineCountFor } from "@minesweeper3d/game-core";
import { testJoin, testRoom, testSummary } from "../test/fixtures";

afterEach(() => cleanup());

const ROOM_ID = "ROOM01";

/** The cube the lobby starts on (`DEFAULT_PRESET_ID` is `classic`). */
const CLASSIC = { x: 5, y: 5, z: 5 } as const;

const SUMMARY: RoomSummaryDto = testSummary({ id: ROOM_ID, mode: "survival", difficultyLabel: "Super hard", mineCount: 25 });
const JOIN: RoomJoinDto = testJoin({ room: testRoom({ id: ROOM_ID }) });

interface Calls {
  readonly create: {
    playerName?: string | undefined;
    presetId?: string | undefined;
    mode?: string | undefined;
    mineCount?: number | undefined;
    visibility?: string | undefined;
    freeReveals?: number | undefined;
  }[];
  readonly join: { roomId: string; playerName?: string | undefined }[];
}

function fakeClient(options: { rooms?: readonly RoomSummaryDto[]; failJoin?: string } = {}): {
  client: RoomClient;
  calls: Calls;
} {
  const calls: Calls = { create: [], join: [] };
  const client: RoomClient = {
    async listRooms() {
      return options.rooms ?? [];
    },
    async createRoom(input) {
      calls.create.push({
        playerName: input?.playerName,
        presetId: input?.presetId,
        mode: input?.mode,
        mineCount: input?.mineCount,
        visibility: input?.visibility,
        freeReveals: input?.freeReveals,
      });
      return JOIN;
    },
    async joinRoom(roomId, input) {
      calls.join.push({ roomId, playerName: input?.playerName });
      if (options.failJoin !== undefined) throw new Error(options.failJoin);
      return JOIN;
    },
    async leaveRoom() {
      // Not exercised by the welcome screen.
    },
  };
  return { client, calls };
}

describe("WelcomeScreen", () => {
  test("offers creating and joining, and lists open rooms", async () => {
    const { client } = fakeClient({ rooms: [SUMMARY] });
    render(<WelcomeScreen client={client} onEnter={() => {}} />);

    expect(screen.getByTestId("welcome-create")).toBeDefined();
    expect(screen.getByTestId("welcome-join")).toBeDefined();
    await waitFor(() => expect(screen.getByTestId("welcome-rooms")).toBeDefined());
    expect(screen.getByTestId(`welcome-room-${ROOM_ID}`)).toBeDefined();
  });

  test("says so when the lobby cannot be listed", async () => {
    const { client } = fakeClient();
    render(<WelcomeScreen client={client} onEnter={() => {}} />);

    await waitFor(() => expect(screen.getByTestId("welcome-rooms-empty")).toBeDefined());
  });

  test("creates a room with the typed name and chosen board", async () => {
    const { client, calls } = fakeClient();
    const entered: RoomJoinDto[] = [];
    render(<WelcomeScreen client={client} onEnter={(join) => entered.push(join)} />);
    await waitFor(() => expect(screen.getByTestId("welcome-rooms-empty")).toBeDefined());

    fireEvent.change(screen.getByTestId("welcome-name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByTestId("welcome-preset"), { target: { value: "tiny" } });
    fireEvent.click(screen.getByTestId("welcome-create"));

    await waitFor(() => expect(entered).toHaveLength(1));
    expect(entered[0]?.room.id).toBe(ROOM_ID);
    // 2 is the classic default (11 mines over 125 cells) rescaled to 27 cells.
    expect(calls.create).toEqual([
      { playerName: "Ada", presetId: "tiny", mode: "coop", mineCount: 2, visibility: "public" },
    ]);
  });

  test("refuses to join without a code", async () => {
    const { client, calls } = fakeClient();
    render(<WelcomeScreen client={client} onEnter={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("welcome-rooms-empty")).toBeDefined());

    fireEvent.click(screen.getByTestId("welcome-join"));

    expect(screen.getByTestId("welcome-error").textContent).toBe("Enter a room code first.");
    expect(calls.join).toHaveLength(0);
  });

  test("surfaces a failed join and stays on the screen", async () => {
    const { client } = fakeClient({ failJoin: `Room "${ROOM_ID}" does not exist` });
    const entered: RoomJoinDto[] = [];
    render(<WelcomeScreen client={client} onEnter={(join) => entered.push(join)} />);

    fireEvent.change(screen.getByTestId("welcome-code"), { target: { value: ROOM_ID } });
    fireEvent.click(screen.getByTestId("welcome-join"));

    await waitFor(() => expect(screen.getByTestId("welcome-error")).toBeDefined());
    expect(screen.getByTestId("welcome-error").textContent).toBe(
      `Could not join the room (Room "${ROOM_ID}" does not exist)`,
    );
    expect(entered).toHaveLength(0);
    expect((screen.getByTestId("welcome-create") as HTMLButtonElement).disabled).toBe(false);
  });

  test("a listed room joins by its code", async () => {
    const { client, calls } = fakeClient({ rooms: [SUMMARY] });
    render(<WelcomeScreen client={client} onEnter={() => {}} />);

    await waitFor(() => expect(screen.getByTestId(`welcome-room-${ROOM_ID}`)).toBeDefined());
    await act(async () => {
      fireEvent.click(screen.getByTestId(`welcome-room-${ROOM_ID}`));
    });

    await waitFor(() => expect(calls.join).toEqual([{ roomId: ROOM_ID, playerName: "Player" }]));
  });

  test("picking a difficulty tier sets the mine count and the indicator", async () => {
    const { client } = fakeClient();
    render(<WelcomeScreen client={client} onEnter={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("welcome-rooms-empty")).toBeDefined());

    expect(screen.getByTestId("welcome-difficulty").getAttribute("data-difficulty")).toBe("normal");
    fireEvent.click(screen.getByTestId("welcome-tier-hard"));

    const hard = mineCountFor(CLASSIC, "hard");
    expect(screen.getByTestId("welcome-mines-value").textContent).toBe(String(hard));
    expect(screen.getByTestId("welcome-difficulty").getAttribute("data-difficulty")).toBe("hard");
    expect(screen.getByTestId("welcome-difficulty").textContent).toBe("Hard");
  });

  test("switching mode recommends that mode's difficulty", async () => {
    const { client } = fakeClient();
    render(<WelcomeScreen client={client} onEnter={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("welcome-rooms-empty")).toBeDefined());

    fireEvent.click(screen.getByTestId("welcome-mode-survival"));

    expect(screen.getByTestId("welcome-difficulty").getAttribute("data-difficulty")).toBe("super-hard");
    expect(screen.getByTestId("welcome-mines-value").textContent).toBe(
      String(mineCountFor(CLASSIC, "super-hard")),
    );
  });

  test("the slider moves the indicator and is sent with the room", async () => {
    const { client, calls } = fakeClient();
    render(<WelcomeScreen client={client} onEnter={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("welcome-rooms-empty")).toBeDefined());

    fireEvent.change(screen.getByTestId("welcome-mines"), {
      target: { value: String(mineCountFor(CLASSIC, "easy")) },
    });
    expect(screen.getByTestId("welcome-difficulty").getAttribute("data-difficulty")).toBe("easy");

    fireEvent.click(screen.getByTestId("welcome-create"));
    await waitFor(() => expect(calls.create).toHaveLength(1));
    expect(calls.create[0]?.mineCount).toBe(mineCountFor(CLASSIC, "easy"));
  });

  test("the free-reveal charges are opt-in, clamped, and sent with the room", async () => {
    const { client, calls } = fakeClient();
    render(<WelcomeScreen client={client} onEnter={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("welcome-rooms-empty")).toBeDefined());

    const field = screen.getByTestId("welcome-free-reveals") as HTMLInputElement;
    // A room that says nothing about the aid gets none.
    expect(field.value).toBe("0");

    fireEvent.change(field, { target: { value: "3" } });
    expect(field.value).toBe("3");

    fireEvent.click(screen.getByTestId("welcome-create"));
    await waitFor(() => expect(calls.create).toHaveLength(1));
    expect(calls.create[0]?.freeReveals).toBe(3);
  });

  test("turns the aid off rather than sending a zero charge count", async () => {
    const { client, calls } = fakeClient();
    render(<WelcomeScreen client={client} onEnter={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("welcome-rooms-empty")).toBeDefined());

    fireEvent.change(screen.getByTestId("welcome-free-reveals"), { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("welcome-create"));
    await waitFor(() => expect(calls.create).toHaveLength(1));
    expect(calls.create[0]?.freeReveals).toBe(2);
  });

  test("a smaller cube cannot spend more charges than it has cells", async () => {
    const { client } = fakeClient();
    render(<WelcomeScreen client={client} onEnter={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("welcome-rooms-empty")).toBeDefined());

    fireEvent.change(screen.getByTestId("welcome-free-reveals"), { target: { value: "50" } });
    const field = screen.getByTestId("welcome-free-reveals") as HTMLInputElement;
    // 5x5x5 = 125 cells, so 50 stands; the engine caps at the cell count.
    expect(field.value).toBe("50");

    fireEvent.change(screen.getByTestId("welcome-preset"), { target: { value: "tiny" } });
    // 3x3x3 = 27 cells: the budget is pulled down with the board.
    expect((screen.getByTestId("welcome-free-reveals") as HTMLInputElement).value).toBe("27");
  });

  test("the cube rescales by density when the board changes", async () => {
    const { client } = fakeClient();
    render(<WelcomeScreen client={client} onEnter={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("welcome-rooms-empty")).toBeDefined());

    fireEvent.click(screen.getByTestId("welcome-tier-hard"));
    const tier = screen.getByTestId("welcome-difficulty").getAttribute("data-difficulty");

    fireEvent.change(screen.getByTestId("welcome-preset"), { target: { value: "large" } });

    expect(screen.getByTestId("welcome-difficulty").getAttribute("data-difficulty")).toBe(tier);
  });

  test("a listed room shows the mode and the mine tier", async () => {
    const { client } = fakeClient({ rooms: [SUMMARY] });
    render(<WelcomeScreen client={client} onEnter={() => {}} />);

    const button = await waitFor(() => screen.getByTestId(`welcome-room-${ROOM_ID}`));
    expect(button.textContent).toContain("Survival");
    expect(button.textContent).toContain("Super hard");
    expect(button.textContent).toContain("25 mines");
  });

  test("a private room is created unlisted and the button says so", async () => {
    const { client, calls } = fakeClient();
    render(<WelcomeScreen client={client} onEnter={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("welcome-rooms-empty")).toBeDefined());

    expect(screen.getByTestId("welcome-create").textContent).toBe("Create room");
    fireEvent.click(screen.getByTestId("welcome-visibility-private"));

    expect(screen.getByTestId("welcome-create").textContent).toBe("Create private room");
    expect(screen.getByTestId("welcome-visibility-private").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("welcome-visibility-public").getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(screen.getByTestId("welcome-create"));
    await waitFor(() => expect(calls.create).toHaveLength(1));
    expect(calls.create[0]?.visibility).toBe("private");
  });

  test("a code from the URL is pre-filled and uppercased", async () => {
    const { client } = fakeClient();
    render(<WelcomeScreen client={client} onEnter={() => {}} initialCode="k7qp2m4xzb" />);
    await waitFor(() => expect(screen.getByTestId("welcome-rooms-empty")).toBeDefined());

    expect((screen.getByTestId("welcome-code") as HTMLInputElement).value).toBe("k7qp2m4xzb");
    fireEvent.change(screen.getByTestId("welcome-code"), { target: { value: " ab 12 " } });
    expect((screen.getByTestId("welcome-code") as HTMLInputElement).value).toBe("AB12");
  });

  test("shows why an automatic join from the URL failed", async () => {
    const { client } = fakeClient({ failJoin: `Room "${ROOM_ID}" does not exist` });
    render(
      <WelcomeScreen
        client={client}
        onEnter={() => {}}
        initialCode={ROOM_ID}
        initialError={`Could not join room ${ROOM_ID}`}
      />,
    );

    expect(screen.getByTestId("welcome-error").textContent).toBe(`Could not join room ${ROOM_ID}`);

    // A new attempt replaces the stale message that came in with the URL.
    fireEvent.click(screen.getByTestId("welcome-join"));
    await waitFor(() =>
      expect(screen.getByTestId("welcome-error").textContent).toBe(
        `Could not join the room (Room "${ROOM_ID}" does not exist)`,
      ),
    );
  });
});
