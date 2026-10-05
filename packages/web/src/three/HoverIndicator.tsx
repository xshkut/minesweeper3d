/**
 * Hover visuals: the translucent cube that covers the hovered cell and the
 * spinning question mark inside it.
 *
 * Both pieces follow the hover slot imperatively (once per frame) so moving the
 * pointer never re-renders React. They are separate components because the
 * question mark needs the font, while the tinted cube must work even if the
 * font fails to load.
 */
import { useEffect, useMemo, useRef } from "react";
import type { ReactElement, RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import { BoxGeometry, MeshBasicMaterial, Quaternion, Vector3 } from "three";
import type { Group, Texture } from "three";
import type { Vec3 } from "@minesweeper3d/game-core";
import { BOARD_COLORS, CELL_SIZE, cellCenter } from "./board";
import type { HoverSlot } from "./hover";
import { useGlyphSet } from "./NumberGlyphs";

/** Hovered cube is drawn slightly larger so it does not z-fight the covered cell. */
const TINT_SCALE = 1.02;
/** Spin speed of the question mark, radians per second. */
const SPIN_SPEED = 4;

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
  const geometry = useMemo(() => new BoxGeometry(CELL_SIZE, CELL_SIZE, CELL_SIZE), []);

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

/** Floating question mark of the hovered cell, spinning and facing the camera. */
export function HoverQuestion({ hover, size }: { readonly hover: HoverSlot; readonly size: Vec3 }): ReactElement {
  const groupRef = useHoverFollow(hover, size);
  const spinRef = useRef<Group>(null);
  const angle = useRef(0);
  const spin = useMemo(() => new Quaternion(), []);
  const axis = useMemo(() => new Vector3(0, 1, 0), []);
  const glyphs = useGlyphSet();
  const material = useMemo(
    () => new MeshBasicMaterial({ color: BOARD_COLORS.question }),
    [],
  );

  useEffect(() => () => material.dispose(), [material]);

  useFrame(({ camera }, delta) => {
    const spinGroup = spinRef.current;
    if (spinGroup === null) return;
    angle.current = (angle.current + delta * SPIN_SPEED) % (Math.PI * 2);
    spin.setFromAxisAngle(axis, angle.current);
    // Billboard first, then spin around the glyph's own vertical axis.
    spinGroup.quaternion.copy(camera.quaternion).multiply(spin);
  });

  return (
    <group ref={groupRef} visible={false}>
      <group ref={spinRef}>
        <mesh geometry={glyphs.geometryFor("question")} material={material} />
      </group>
    </group>
  );
}

/** Keeps a group at the centre of the hovered cell, hiding it when there is none. */
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
