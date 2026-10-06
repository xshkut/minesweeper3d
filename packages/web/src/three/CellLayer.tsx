/**
 * Everything that visualises one board: the instanced covered cells, the
 * adjacency numbers and the revealed mines.
 *
 * Covered cells are one `instancedMesh` (a single draw call for up to a
 * thousand cells) with per-instance colours, which also gives the pointer layer
 * a single place to handle clicks.
 */
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { ReactElement } from "react";
import { Color, MeshStandardMaterial, Object3D } from "three";
import type { InstancedMesh, Texture } from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { createGrid } from "@minesweeper3d/game-core";
import type { CellIndex, ClientGameState } from "@minesweeper3d/game-core";
import { BOARD_COLORS, CELL_SIZE, CORNER_RADIUS, CORNER_SEGMENTS, cellCenter } from "./board";
import { CellMarks } from "./CellMarks";
import { ErrorBoundary } from "./ErrorBoundary";
import { HoverTint } from "./HoverIndicator";
import { MineModel } from "./MineModel";
import { GlyphProvider, NumberGlyphs } from "./NumberGlyphs";
import { PlayerCursors } from "./PlayerCursors";
import { useBoardPointer } from "./useBoardPointer";
import type { BlockedReason, BoardPointerHandlers, BoardTool } from "./useBoardPointer";
import type { HoverSlot } from "./hover";
import type { PointerState } from "./pointerState";
import type { Point3 } from "./orbit";
import type { PresenceView } from "../session/presence";

/** Props of {@link CellLayer}. */
export interface CellLayerProps {
  readonly state: ClientGameState;
  readonly texture: Texture;
  readonly tool: BoardTool;
  readonly hover: HoverSlot;
  readonly pointer: PointerState;
  readonly onReveal: (cell: CellIndex) => void;
  readonly onMark: (cell: CellIndex) => void;
  readonly onProbe: (cell: CellIndex) => void;
  readonly onBlocked: (cell: CellIndex, reason: BlockedReason) => void;
  readonly onRecenter: (point: Point3) => void;
  /** The other seats of the room; absent in a private game. */
  readonly presence?: PresenceView | undefined;
  /** Reports where this player is pointing, when the session cares. */
  readonly onCursor?: ((cell: CellIndex | null) => void) | undefined;
}

/** Renders the board of the current state. Must be inside `<Canvas>`. */
export function CellLayer(props: CellLayerProps): ReactElement {
  const { state, texture, tool, hover, pointer, onReveal, onMark, onProbe, onBlocked, onRecenter, presence, onCursor } =
    props;
  const size = state.config.size;
  const won = state.status === "won";

  const grid = useMemo(
    // Rebuilt only when the board actually changes shape.
    () => createGrid(size),
    [size.x, size.y, size.z],
  );

  const handlers = useBoardPointer({
    state,
    hover,
    pointer,
    tool,
    onReveal,
    onMark,
    onProbe,
    onBlocked,
    onRecenter,
    onCursor,
  });

  // Soft corners are what make the cubes read as objects rather than as a grid.
  // The geometry is built once per board, not per cell: all covered cubes share
  // it through the instanced mesh below.
  const geometry = useMemo(
    () => new RoundedBoxGeometry(CELL_SIZE, CELL_SIZE, CELL_SIZE, CORNER_SEGMENTS, CORNER_RADIUS),
    [],
  );
  // Standard rather than basic material: a lit surface is what actually shows the
  // round-over, and the scene already carries the lights for it.
  const coveredMaterial = useMemo(
    () => new MeshStandardMaterial({ map: texture, roughness: 0.42, metalness: 0.05 }),
    [texture],
  );
  const coveredColor = useMemo(() => new Color(BOARD_COLORS.covered), []);
  const flagColor = useMemo(() => new Color(BOARD_COLORS.flag), []);
  const questionColor = useMemo(() => new Color(BOARD_COLORS.questioned), []);
  const probedMineColor = useMemo(() => new Color(BOARD_COLORS.probedMine), []);
  const probedSafeColor = useMemo(() => new Color(BOARD_COLORS.probedSafe), []);

  useEffect(
    () => () => {
      geometry.dispose();
      coveredMaterial.dispose();
    },
    [geometry, coveredMaterial],
  );

  const mines = useMemo(() => state.cells.filter((cell) => cell.isRevealed && cell.hasMine), [state]);

  return (
    <group>
      <CoveredCells
        state={state}
        count={state.cells.length}
        geometry={geometry}
        material={coveredMaterial}
        tint={{
          covered: coveredColor,
          flag: flagColor,
          question: questionColor,
          probedMine: probedMineColor,
          probedSafe: probedSafeColor,
        }}
        handlers={handlers}
      />

      <HoverTint hover={hover} size={size} texture={texture} />

      <ErrorBoundary fallback={null}>
        <Suspense fallback={null}>
          <GlyphProvider>
            <NumberGlyphs state={state} />
            <CellMarks state={state} />
          </GlyphProvider>
        </Suspense>
      </ErrorBoundary>

      {mines.map((cell) => (
        <MineModel key={grid.offsetOf(cell.index)} cell={cell.index} size={size} won={won} />
      ))}

      {presence !== undefined && presence.seats.length > 0 && (
        <PlayerCursors feed={presence.feed} seats={presence.seats} size={size} />
      )}
    </group>
  );
}

/** Per-state tints of a covered cube, one `Color` per state. */
interface CoveredTint {
  readonly covered: Color;
  readonly flag: Color;
  readonly question: Color;
  readonly probedMine: Color;
  readonly probedSafe: Color;
}

interface CoveredCellsProps {
  readonly state: ClientGameState;
  readonly count: number;
  readonly geometry: RoundedBoxGeometry;
  readonly material: MeshStandardMaterial;
  readonly tint: CoveredTint;
  readonly handlers: BoardPointerHandlers;
}

/**
 * Tint of one covered cube.
 *
 * A probe verdict outranks a mark: the charge bought a fact about the board and
 * the flag beside it would only obscure it.
 */
function tintOf(cell: { isFlagged: boolean; isQuestioned: boolean; isProbed: boolean; hasMine: boolean }, tint: CoveredTint): Color {
  if (cell.isProbed) return cell.hasMine ? tint.probedMine : tint.probedSafe;
  if (cell.isQuestioned) return tint.question;
  if (cell.isFlagged) return tint.flag;
  return tint.covered;
}

/**
 * All covered cells as one instanced mesh.
 *
 * Revealed cells keep their slot but get a zero scale, so instance ids stay in
 * sync with grid offsets and the raycast simply cannot hit them.
 */
function CoveredCells({
  state,
  count,
  geometry,
  material,
  tint,
  handlers,
}: CoveredCellsProps): ReactElement {
  const meshRef = useRef<InstancedMesh>(null);
  const scratch = useMemo(() => new Object3D(), []);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;

    for (let offset = 0; offset < count; offset += 1) {
      const cell = state.cells[offset];
      if (cell === undefined) continue;

      const center = cellCenter(cell.index, state.config.size);
      scratch.position.set(center.x, center.y, center.z);
      scratch.scale.setScalar(cell.isRevealed ? 0 : 1);
      scratch.updateMatrix();

      mesh.setMatrixAt(offset, scratch.matrix);
      mesh.setColorAt(offset, tintOf(cell, tint));
    }

    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  }, [state, count, scratch, tint]);

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, count]}
      // Instance matrices move around, so the geometry-only bounding sphere is
      // not a safe culling test.
      frustumCulled={false}
      {...handlers}
    />
  );
}
