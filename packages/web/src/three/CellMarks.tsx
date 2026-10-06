/**
 * The marks that sit *on* a covered cube: the question mark and the result of a
 * free reveal.
 *
 * Every mark lives at its cell centre plus {@link MARK_OFFSET} along the line to
 * the camera, because a glyph at the centre is buried inside an opaque cube and
 * would never be drawn. That offset has to be recomputed as the camera orbits,
 * so one group walks its own children once per frame rather than mounting a
 * `useFrame` per mark.
 *
 * Shapes differ as well as colours - a sphere for a probe result, an extruded
 * glyph for a question mark, and the cube itself is tinted - so the three states
 * stay apart for a player who cannot tell red from green.
 */
import { useEffect, useMemo, useRef } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import { MeshBasicMaterial, MeshStandardMaterial, SphereGeometry, Vector3 } from "three";
import type { Group } from "three";
import { cellKey } from "@minesweeper3d/game-core";
import type { ClientGameState, Vec3 } from "@minesweeper3d/game-core";
import { BOARD_COLORS, CELL_SIZE, MARK_OFFSET, cellCenter } from "./board";
import type { Point3 } from "./orbit";
import { useGlyphSet } from "./NumberGlyphs";

/** What a mark says about its cell. */
type MarkKind = "question" | "probedMine" | "probedSafe";

interface Mark {
  readonly key: string;
  readonly kind: MarkKind;
  readonly center: Point3;
}

/** Radius of the probe-result ball. */
const PROBE_RADIUS = CELL_SIZE * 0.22;

/**
 * Marks of a board, in cell order.
 *
 * A cell can only carry one: the engine keeps flags and question marks in one
 * slot, and a probe replaces both with its verdict.
 */
function marksOf(state: ClientGameState, size: Vec3): Mark[] {
  const marks: Mark[] = [];
  for (const cell of state.cells) {
    let kind: MarkKind | null = null;
    if (cell.isProbed) kind = cell.hasMine ? "probedMine" : "probedSafe";
    else if (cell.isQuestioned) kind = "question";
    if (kind === null) continue;
    marks.push({ key: cellKey(cell.index), kind, center: cellCenter(cell.index, size) });
  }
  return marks;
}

/** Question marks and probe results of a board. Must be inside `<GlyphProvider>`. */
export function CellMarks({ state }: { readonly state: ClientGameState }): ReactElement {
  const glyphs = useGlyphSet();
  const groupRef = useRef<Group>(null);
  const marks = useMemo(() => marksOf(state, state.config.size), [state]);

  const materials = useMemo(
    () => ({
      question: new MeshBasicMaterial({ color: BOARD_COLORS.question }),
      probedMine: new MeshStandardMaterial({
        color: BOARD_COLORS.probedMine,
        roughness: 0.3,
        metalness: 0.1,
      }),
      probedSafe: new MeshStandardMaterial({
        color: BOARD_COLORS.probedSafe,
        roughness: 0.3,
        metalness: 0.1,
      }),
    }),
    [],
  );
  const sphere = useMemo(() => new SphereGeometry(PROBE_RADIUS, 20, 14), []);

  useEffect(
    () => () => {
      for (const material of Object.values(materials)) material.dispose();
      sphere.dispose();
    },
    [materials, sphere],
  );

  // Scratch vectors, so the per-frame pass allocates nothing.
  const view = useMemo(() => new Vector3(), []);
  const origin = useMemo(() => new Vector3(), []);

  useFrame(({ camera }) => {
    const group = groupRef.current;
    if (group === null) return;

    for (const child of group.children) {
      const center = child.userData["center"] as Point3 | undefined;
      if (center === undefined) continue;

      origin.set(center.x, center.y, center.z);
      view.copy(camera.position).sub(origin);
      const distance = view.length();
      // A camera exactly on the cell would divide by zero; the mark then simply
      // stays at the centre for that one frame.
      if (distance > 0) view.multiplyScalar(MARK_OFFSET / distance);
      child.position.set(center.x + view.x, center.y + view.y, center.z + view.z);
      child.quaternion.copy(camera.quaternion);
    }
  });

  return (
    <group ref={groupRef}>
      {marks.map((mark) => (
        <mesh
          key={mark.key}
          userData={{ center: mark.center }}
          geometry={mark.kind === "question" ? glyphs.geometryFor("question") : sphere}
          material={materials[mark.kind]}
        />
      ))}
    </group>
  );
}
