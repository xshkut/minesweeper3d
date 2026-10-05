/**
 * The revealed mines: a generated spiked ball (OBJ plus PNG albedo).
 *
 * Both assets are loaded lazily through Suspense the first time a mine is
 * revealed, so a missing or broken model degrades to a simple ball instead of
 * taking the board - or the game - down with it.
 */
import { Suspense, useEffect, useMemo } from "react";
import type { ReactElement } from "react";
import { useLoader } from "@react-three/fiber";
import { Box3, MeshStandardMaterial, SRGBColorSpace, TextureLoader, Vector3 } from "three";
import type { BufferGeometry, Object3D } from "three";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import type { CellIndex } from "@minesweeper3d/game-core";
import { ASSETS, assetUrl } from "./assets";
import { BOARD_COLORS, CELL_SIZE, cellCenter } from "./board";
import { ErrorBoundary } from "./ErrorBoundary";
import type { Point3 } from "./orbit";

/** Props shared by the model and its fallback. */
interface MineProps {
  readonly cell: CellIndex;
  readonly size: { readonly x: number; readonly y: number; readonly z: number };
  /** `true` once the game is won, which turns the mines green. */
  readonly won: boolean;
}

/** Fraction of a cell the mine model should fill. */
const MINE_FILL = 0.8;

/** Revealed mine; the model loads through Suspense with a ball as fallback. */
export function MineModel(props: MineProps): ReactElement {
  return (
    <ErrorBoundary fallback={<FallbackMine {...props} />}>
      <Suspense fallback={<FallbackMine {...props} />}>
        <SpikedBall {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}

/** Simple sphere used while the model loads and when it cannot be loaded. */
function FallbackMine({ cell, size, won }: MineProps): ReactElement {
  return (
    <mesh position={toPosition(cellCenter(cell, size))}>
      <sphereGeometry args={[CELL_SIZE * MINE_FILL * 0.5, 16, 12]} />
      <meshStandardMaterial
        color={won ? BOARD_COLORS.mineWon : BOARD_COLORS.mine}
        roughness={0.6}
        metalness={0.2}
      />
    </mesh>
  );
}

/** The actual OBJ + PNG pair. */
function SpikedBall({ cell, size, won }: MineProps): ReactElement {
  const object = useLoader(OBJLoader, assetUrl(ASSETS.mineModel));
  const texture = useLoader(TextureLoader, assetUrl(ASSETS.mineTexture));

  const geometries = useMemo(() => collectGeometries(object), [object]);
  const scale = useMemo(() => fitScale(geometries), [geometries]);
  const material = useMemo(() => {
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
    return new MeshStandardMaterial({
      map: texture,
      color: won ? BOARD_COLORS.mineWon : BOARD_COLORS.mine,
      roughness: 0.5,
      metalness: 0.25,
    });
  }, [texture, won]);

  // The texture is owned by the loader cache, the material is ours.
  useEffect(() => () => material.dispose(), [material]);

  return (
    <group position={toPosition(cellCenter(cell, size))} scale={scale}>
      {geometries.map((geometry, index) => (
        <mesh key={`${geometry.uuid}-${index}`} geometry={geometry} material={material} />
      ))}
    </group>
  );
}

/** Every mesh geometry of a loaded OBJ, in a stable order. */
function collectGeometries(object: Object3D): BufferGeometry[] {
  const geometries: BufferGeometry[] = [];
  const seen = new Set<string>();
  object.traverse((child) => {
    const mesh = child as Object3D & { geometry?: BufferGeometry; isMesh?: boolean };
    if (mesh.isMesh !== true || mesh.geometry === undefined) return;
    if (seen.has(mesh.geometry.uuid)) return;
    seen.add(mesh.geometry.uuid);
    geometries.push(mesh.geometry);
  });
  return geometries;
}

/** Uniform scale that fits the model into a cell, whatever unit it was authored in. */
function fitScale(geometries: readonly BufferGeometry[]): number {
  if (geometries.length === 0) return 1;

  const box = new Box3();
  const size = new Vector3();
  for (const geometry of geometries) {
    geometry.computeBoundingBox();
    const bounds = geometry.boundingBox;
    if (bounds !== null) box.union(bounds);
  }
  box.getSize(size);
  const longest = Math.max(size.x, size.y, size.z);
  return longest > 0 ? (CELL_SIZE * MINE_FILL) / longest : 1;
}

function toPosition(point: Point3): [number, number, number] {
  return [point.x, point.y, point.z];
}
