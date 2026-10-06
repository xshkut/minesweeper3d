/**
 * Hover visuals: the translucent cube that covers the hovered cell.
 *
 * The tint follows the hover slot imperatively (once per frame) so moving the
 * pointer never re-renders React.
 */
import { useEffect, useMemo, useRef } from "react";
import type { ReactElement, RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import { MeshBasicMaterial } from "three";
import type { Group, Texture } from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { Vec3 } from "@minesweeper3d/game-core";
import { BOARD_COLORS, CELL_SIZE, CORNER_RADIUS, CORNER_SEGMENTS, cellCenter } from "./board";
import type { HoverSlot } from "./hover";

/** Hovered cube is drawn slightly larger so it does not z-fight the covered cell. */
const TINT_SCALE = 1.02;

/** Translucent tint over the hovered covered cell. */
export function HoverTint({
  hover,
  size,
  texture,
}: {
  readonly hover: HoverSlot;
  readonly size: Vec3;
  readonly texture: Texture;
}): ReactElement {
  const groupRef = useHoverFollow(hover, size);
  const material = useMemo(
    () =>
      new MeshBasicMaterial({
        map: texture,
        color: BOARD_COLORS.hover,
        transparent: true,
        opacity: 0.7,
      }),
    [texture],
  );
  const geometry = useMemo(
    () => new RoundedBoxGeometry(CELL_SIZE, CELL_SIZE, CELL_SIZE, CORNER_SEGMENTS, CORNER_RADIUS),
    [],
  );

  useEffect(
    () => () => {
      material.dispose();
      geometry.dispose();
    },
    [material, geometry],
  );

  return (
    <group ref={groupRef} visible={false}>
      <mesh geometry={geometry} material={material} scale={TINT_SCALE} />
    </group>
  );
}

/**
 * Keeps a group at the centre of the hovered cell, hiding it when there is none.
 */
function useHoverFollow(hover: HoverSlot, size: Vec3): RefObject<Group | null> {
  const groupRef = useRef<Group>(null);
  const appliedRevision = useRef(-1);

  useFrame(() => {
    const group = groupRef.current;
    if (group === null) return;

    const cell = hover.cell;
    group.visible = cell !== null;
    if (cell === null || hover.revision === appliedRevision.current) return;

    appliedRevision.current = hover.revision;
    const center = cellCenter(cell, size);
    group.position.set(center.x, center.y, center.z);
  });

  return groupRef;
}
