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
import { BoxGeometry, Color, MeshBasicMaterial, Object3D } from "three";
import type { InstancedMesh, Texture } from "three";
import { createGrid } from "@minesweeper3d/game-core";
import type { CellIndex, ClientGameState } from "@minesweeper3d/game-core";
import { BOARD_COLORS, CELL_SIZE, cellCenter } from "./board";
import { ErrorBoundary } from "./ErrorBoundary";
import { HoverQuestion, HoverTint } from "./HoverIndicator";
import { MineModel } from "./MineModel";
import { GlyphProvider, NumberGlyphs } from "./NumberGlyphs";
import { useBoardPointer } from "./useBoardPointer";
import type { BlockedReason, BoardPointerHandlers } from "./useBoardPointer";
import type { HoverSlot } from "./hover";
import type { PointerState } from "./pointerState";
import type { Point3 } from "./orbit";

/** Props of {@link CellLayer}. */
export interface CellLayerProps {
  readonly state: ClientGameState;
  readonly texture: Texture;
  readonly flagMode: boolean;
  readonly hover: HoverSlot;
  readonly pointer: PointerState;
  readonly onReveal: (cell: CellIndex) => void;
  readonly onFlag: (cell: CellIndex) => void;
  readonly onBlocked: (cell: CellIndex, reason: BlockedReason) => void;
  readonly onRecenter: (point: Point3) => void;
}

/** Renders the board of the current state. Must be inside `<Canvas>`. */
export function CellLayer(props: CellLayerProps): ReactElement {
  const { state, texture, flagMode, hover, pointer, onReveal, onFlag, onBlocked, onRecenter } = props;
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
    flagMode,
    onReveal,
    onFlag,
    onBlocked,
    onRecenter,
  });

  const geometry = useMemo(() => new BoxGeometry(CELL_SIZE, CELL_SIZE, CELL_SIZE), []);
  const coveredMaterial = useMemo(() => new MeshBasicMaterial({ map: texture }), [texture]);
  const coveredColor = useMemo(() => new Color(BOARD_COLORS.covered), []);
  const flagColor = useMemo(() => new Color(BOARD_COLORS.flag), []);

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
        coveredColor={coveredColor}
        flagColor={flagColor}
        handlers={handlers}
      />

      <HoverTint hover={hover} size={size} texture={texture} />

      <ErrorBoundary fallback={null}>
        <Suspense fallback={null}>
          <GlyphProvider>
            <NumberGlyphs state={state} />
            <HoverQuestion hover={hover} size={size} />
          </GlyphProvider>
        </Suspense>
      </ErrorBoundary>

      {mines.map((cell) => (
        <MineModel key={grid.offsetOf(cell.index)} cell={cell.index} size={size} won={won} />
      ))}
    </group>
  );
}

interface CoveredCellsProps {
  readonly state: ClientGameState;
  readonly count: number;
  readonly geometry: BoxGeometry;
  readonly material: MeshBasicMaterial;
  readonly coveredColor: Color;
  readonly flagColor: Color;
  readonly handlers: BoardPointerHandlers;
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
  coveredColor,
  flagColor,
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
      mesh.setColorAt(offset, cell.isFlagged ? flagColor : coveredColor);
    }

    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  }, [state, count, scratch, coveredColor, flagColor]);

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
