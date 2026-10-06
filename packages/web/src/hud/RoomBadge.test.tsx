/**
 * Room panel tests: the panel is pure, so every match state is rendered directly
 * from a fixture - no socket, no server.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RoomBadge } from "./RoomBadge";
import { playerColor } from "../session/presence";
import { testPlayer, testRoom } from "../test/fixtures";

afterEach(() => cleanup());

const AT = Date.parse("2026-01-01T00:00:00.000Z");
const clock = (): number => AT;

describe("RoomBadge", () => {
  test("renders nothing outside a room", () => {
    const { container } = render(<RoomBadge room={null} playerId={null} />);
    expect(container.innerHTML).toBe("");
  });

  test("shows the match mode, the cube and the mine tier", () => {
    render(
      <RoomBadge
        room={testRoom({ mode: "survival", mineCount: 25, difficultyId: "super-hard", difficultyLabel: "Super hard", size: { x: 5, y: 5, z: 5 } })}
        playerId="p1"
      />,
    );

    expect(screen.getByTestId("room-mode").textContent).toBe("Survival");
    expect(screen.getByTestId("room-board").textContent).toBe("5×5×5");
    expect(screen.getByTestId("room-mines").textContent).toContain("25");
    expect(screen.getByTestId("room-difficulty").getAttribute("data-difficulty")).toBe("super-hard");
    expect(screen.getByTestId("room-round").textContent).toBe("1");
  });

  test("flags an unlisted room and stays quiet about a public one", () => {
    const { unmount } = render(<RoomBadge room={testRoom({ visibility: "private" })} playerId="p1" />);

    const badge = screen.getByTestId("room-visibility");
    expect(badge.textContent).toBe("Private");
    expect(badge.getAttribute("data-visibility")).toBe("private");
    expect(badge.getAttribute("title")).toContain("Hidden from the lobby");
    unmount();

    render(<RoomBadge room={testRoom({ visibility: "public" })} playerId="p1" />);
    expect(screen.queryByTestId("room-visibility")).toBeNull();
  });

  test("counts down to the co-op deadline", () => {
    render(
      <RoomBadge
        room={testRoom({
          mode: "coop",
          status: "playing",
          deadlineAt: new Date(AT + 95_000).toISOString(),
        })}
        playerId="p1"
        now={clock}
      />,
    );

    expect(screen.getByTestId("room-clock").textContent).toContain("1:35");
  });

  test("hides the clock when no round is running", () => {
    render(<RoomBadge room={testRoom({ mode: "coop" })} playerId="p1" now={clock} />);
    expect(screen.queryByTestId("room-clock")).toBeNull();
  });

  test("marks who left the round and who is out", () => {
    render(
      <RoomBadge
        room={testRoom({
          mode: "survival",
          status: "won",
          players: [
            testPlayer({ id: "p1", name: "Ada", outcome: "out", revealedCount: 12 }),
            testPlayer({ id: "p2", name: "Lin", outcome: "cleared" }),
          ],
        })}
        playerId="p2"
      />,
    );

    expect(screen.getByTestId("room-outcome-p1").textContent).toBe("out");
    expect(screen.getByTestId("room-outcome-p2").textContent).toBe("cleared");
    expect(screen.getByTestId("room-players").textContent).toContain("(you)");
    expect(screen.getByTestId("room-result").textContent).toBe("Lin is still digging.");
  });

  test("names the race winner", () => {
    render(
      <RoomBadge
        room={testRoom({
          mode: "race",
          status: "won",
          players: [testPlayer({ id: "p1", name: "Ada", outcome: "cleared" }), testPlayer({ id: "p2", name: "Lin" })],
        })}
        playerId="p2"
      />,
    );

    expect(screen.getByTestId("room-result").textContent).toBe("Ada disarmed the cube first.");
  });

  test("reports a beaten co-op clock", () => {
    render(<RoomBadge room={testRoom({ mode: "coop", status: "lost" })} playerId="p1" />);
    expect(screen.getByTestId("room-result").textContent).toBe("The clock beat you.");
  });

  test("leaves the room", () => {
    let left = 0;
    render(<RoomBadge room={testRoom()} playerId="p1" onLeave={() => (left += 1)} />);
    fireEvent.click(screen.getByTestId("leave-room"));
    expect(left).toBe(1);
  });

  test("shows every player in the colour of the pointer they drive", () => {
    render(
      <RoomBadge
        room={testRoom({
          players: [testPlayer({ id: "p1", name: "Ada" }), testPlayer({ id: "p2", name: "Lin" })],
        })}
        playerId="p1"
      />,
    );

    // The roster is the only key to the markers on the board, so the colour has
    // to be the very same one, not merely a similar one.
    expect(screen.getByTestId("room-swatch-p2").getAttribute("data-player-color")).toBe(playerColor("p2"));
    expect(asHex(screen.getByTestId("room-swatch-p2").style.backgroundColor)).toBe(playerColor("p2"));
    expect(playerColor("p2")).not.toBe(playerColor("p1"));
  });
});

/** happy-dom reports an inline colour as `rgb(r, g, b)`; the palette is hex. */
function asHex(color: string): string {
  const rgb = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(color);
  if (rgb === null) return color.toLowerCase();
  return `#${rgb
    .slice(1, 4)
    .map((part) => Number(part).toString(16).padStart(2, "0"))
    .join("")}`;
}
