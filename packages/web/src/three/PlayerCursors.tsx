/**
 * Everybody else's pointer, drawn as a point that slides and a tail that fades.
 *
 * One group per remote seat. The component owns no React state at all: it reads
 * the {@link CursorFeed} the session mutates and advances a pure {@link CursorTrail}
 * once per frame, exactly like the hover indicator, so another player moving
 * their mouse never re-renders this app.
 *
 * Every sphere floats {@link MARK_OFFSET} towards the camera from its board
 * position, for the same reason the marks do: a dot at a cell centre would sit
 * inside an opaque cube and never be drawn.
 */
import { useEffect, useMemo, useRef } from "react";
import type { ReactElement } from "react";
import { useFrame } from "@react-three/fiber";
import { Color, MeshBasicMaterial, SphereGeometry } from "three";
import type { Camera, Group, Mesh } from "three";
import type { Vec3 } from "@minesweeper3d/game-core";
import { MARK_OFFSET, cellCenter } from "./board";
import { MAX_SAMPLES, TRAIL_LIFE_SECONDS, advanceCursorTrail, createCursorTrail, trailIsVisible } from "./trail";
import type { TrailPoint } from "./trail";
import { playerColor } from "../session/presence";
import type { CursorFeed, RemoteSeat } from "../session/presence";

/** Radius of the sliding point itself, in board units. */
const HEAD_RADIUS = 1.7;
/** Radius of the newest bead of the tail, and of the oldest one before it goes. */
const BEAD_RADIUS = 1.5;
const BEAD_END_RADIUS = 0.35;
/** Translucency of a fresh bead, so the board stays readable through the tail. */
const BEAD_OPACITY = 0.75;

const SPHERE_SEGMENTS = 16;
const SPHERE_RINGS = 12;

export interface PlayerCursorsProps {
  readonly feed: CursorFeed;
  readonly seats: readonly RemoteSeat[];
  readonly size: Vec3;
}

/** Draws one sliding point with its fading tail per remote seat. */
export function PlayerCursors({ feed, seats, size }: PlayerCursorsProps): ReactElement {
  return (
    <>
      {seats.map((seat) => (
        <SeatCursor key={seat.id} feed={feed} seat={seat} size={size} />
      ))}
    </>
  );
}

function SeatCursor({ feed, seat, size }: { readonly feed: CursorFeed; readonly seat: RemoteSeat; readonly size: Vec3 }): ReactElement {
  const groupRef = useRef<Group>(null);
  const headRef = useRef<Mesh>(null);
  const beadRefs = useRef<(Mesh | null)[]>([]);
  const trail = useMemo(createCursorTrail, []);
  const color = useMemo(() => new Color(playerColor(seat.id)), [seat.id]);

  const geometry = useMemo(() => new SphereGeometry(1, SPHERE_SEGMENTS, SPHERE_RINGS), []);
  const headMaterial = useMemo(
    () => new MeshBasicMaterial({ color, transparent: true, depthWrite: false }),
    [color],
  );
  // One material per bead, because each bead fades on its own clock; the program
  // itself is shared, since every one of them is configured identically.
  const beadMaterials = useMemo(
    () =>
      Array.from({ length: MAX_SAMPLES }, () => new MeshBasicMaterial({ color, transparent: true, depthWrite: false })),
    [color],
  );

  useEffect(
    () => () => {
      geometry.dispose();
      headMaterial.dispose();
      for (const material of beadMaterials) material.dispose();
    },
    [geometry, headMaterial, beadMaterials],
  );

  useFrame(({ camera }, delta) => {
    const cursor = feed.cursors.get(seat.id);
    const cell = cursor?.cell ?? null;
    advanceCursorTrail(trail, cell === null ? null : cellCenter(cell, size), delta);

    const group = groupRef.current;
    if (group === null) return;

    group.visible = trailIsVisible(trail);
    if (!group.visible) return;

    const head = headRef.current;
    if (head !== null) {
      place(head, trail.head, camera, HEAD_RADIUS);
      headMaterial.opacity = trail.opacity;
    }

    for (let index = 0; index < beadMaterials.length; index += 1) {
      const bead = beadRefs.current[index];
      const material = beadMaterials[index];
      const sample = trail.samples[index];
      if (bead === undefined || bead === null || material === undefined) continue;
      if (sample === undefined) {
        bead.visible = false;
        continue;
      }

      const fade = 1 - sample.age / TRAIL_LIFE_SECONDS;
      bead.visible = true;
      place(bead, sample, camera, BEAD_END_RADIUS + (BEAD_RADIUS - BEAD_END_RADIUS) * fade);
      material.opacity = trail.opacity * fade * BEAD_OPACITY;
    }
  });

  return (
    <group ref={groupRef} visible={false}>
      <mesh ref={headRef} geometry={geometry} material={headMaterial} />
      {beadMaterials.map((material, index) => (
        <mesh
          key={index}
          geometry={geometry}
          material={material}
          ref={(mesh) => {
            beadRefs.current[index] = mesh;
          }}
        />
      ))}
    </group>
  );
}

/** Parks a sphere at a board position, offset towards the camera and scaled. */
function place(mesh: Mesh, point: TrailPoint, camera: Camera, radius: number): void {
  const dx = camera.position.x - point.x;
  const dy = camera.position.y - point.y;
  const dz = camera.position.z - point.z;
  const length = Math.hypot(dx, dy, dz);
  const scale = length > 0 ? MARK_OFFSET / length : 0;
  mesh.position.set(point.x + dx * scale, point.y + dy * scale, point.z + dz * scale);
  mesh.scale.setScalar(radius);
}
