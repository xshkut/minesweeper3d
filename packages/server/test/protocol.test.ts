/**
 * The wire protocol's trust boundary.
 *
 * Every frame a socket receives is untrusted input, so these tests pin the two
 * promises the app depends on: a malformed frame becomes a typed rejection that
 * can be reported back over the same socket, and an accepted frame is a freshly
 * built object rather than a reference to the caller's payload.
 */
import { describe, expect, test } from "bun:test";
import { INVALID_CELL, INVALID_MESSAGE, parseClientMessage, parseClientMessageText, serializeServerMessage } from "../src/realtime/protocol";

describe("cursor frames", () => {
  test("accepts a cell and normalises it to three integers", () => {
    const parsed = parseClientMessage({ type: "cursor", cell: { x: 1, y: 2, z: 3 } });
    expect(parsed).toEqual({ ok: true, message: { type: "cursor", cell: { x: 1, y: 2, z: 3 } } });
  });

  test("accepts null, the explicit \"not pointing anywhere\"", () => {
    expect(parseClientMessage({ type: "cursor", cell: null })).toEqual({
      ok: true,
      message: { type: "cursor", cell: null },
    });
  });

  test("rejects a missing cell as an invalid cell, not an unknown type", () => {
    const parsed = parseClientMessage({ type: "cursor" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe(INVALID_CELL);
    expect(parsed.message).toContain("cursor");
    expect(parsed.details[0]).toContain("null to stop pointing");
  });

  test("rejects fractional coordinates, which no cell has", () => {
    const parsed = parseClientMessage({ type: "cursor", cell: { x: 0.5, y: 0, z: 0 } });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe(INVALID_CELL);
  });

  test("accepts out-of-bounds cells: a pointer is a hint, not an action", () => {
    // The board's size belongs to the game, not to the transport; a cell far
    // outside it must not cost the player an error frame per mouse move.
    expect(parseClientMessage({ type: "cursor", cell: { x: 99, y: -4, z: 7 } }).ok).toBe(true);
  });

  test("copies the cell rather than keeping the caller's object", () => {
    const cell = { x: 1, y: 1, z: 1 };
    const parsed = parseClientMessage({ type: "cursor", cell });
    if (!parsed.ok || parsed.message.type !== "cursor" || parsed.message.cell === null) {
      throw new Error("expected an accepted cursor frame");
    }
    expect(parsed.message.cell).not.toBe(cell);
    expect(parsed.message.cell).toEqual(cell);
  });

  test("survives being round-tripped through text", () => {
    const parsed = parseClientMessageText('{"type":"cursor","cell":null}');
    expect(parsed).toEqual({ ok: true, message: { type: "cursor", cell: null } });
  });
});

describe("unknown frames", () => {
  test("advertise every supported type, cursor included", () => {
    const parsed = parseClientMessage({ type: "flag", cell: { x: 0, y: 0, z: 0 } });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe(INVALID_MESSAGE);
    expect(parsed.details).toEqual(["supported types: reveal, mark, probe, cursor, ping"]);
  });
});

describe("server messages", () => {
  test("a cursor frame serialises to the shape the client parses", () => {
    expect(serializeServerMessage({ type: "cursor", playerId: "p1", cell: { x: 0, y: 1, z: 2 } })).toBe(
      '{"type":"cursor","playerId":"p1","cell":{"x":0,"y":1,"z":2}}',
    );
  });

  test("a cleared cursor keeps the null", () => {
    expect(serializeServerMessage({ type: "cursor", playerId: "p1", cell: null })).toBe(
      '{"type":"cursor","playerId":"p1","cell":null}',
    );
  });
});
