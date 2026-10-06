/**
 * Text glyphs for the adjacency numbers and the cell question marks.
 *
 * `TextGeometry` is expensive to build, so every glyph is created once per
 * loaded font and cached; the cache is disposed together with its provider.
 */
import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import type { ReactElement, ReactNode } from "react";
import { useFrame, useLoader } from "@react-three/fiber";
import { MeshStandardMaterial } from "three";
import type { BufferGeometry, Group } from "three";
import { FontLoader } from "three/addons/loaders/FontLoader.js";
import type { Font } from "three/addons/loaders/FontLoader.js";
import { TextGeometry } from "three/addons/geometries/TextGeometry.js";
import { cellKey } from "@minesweeper3d/game-core";
import type { ClientGameState } from "@minesweeper3d/game-core";
import { ASSETS, assetUrl } from "./assets";
import { BOARD_COLORS, CELL_SIZE, cellCenter } from "./board";

/** A cached glyph: any adjacency count, or the question mark. */
export type GlyphKey = number | "question";

/** Lazily built, cached glyph geometries. */
export interface GlyphSet {
  /** Geometry for a key, created on first use. */
  geometryFor(key: GlyphKey): BufferGeometry;
  /** Releases every cached geometry. */
  dispose(): void;
}

/** Font metrics ported from the prototype (`size: 0.6 * basis`). */
const GLYPH_SIZE = CELL_SIZE * 0.6;
const GLYPH_DEPTH = CELL_SIZE * 0.1;

/** Builds the cache for one font. */
export function createGlyphSet(font: Font): GlyphSet {
  const cache = new Map<GlyphKey, BufferGeometry>();

  return {
    geometryFor(key) {
      const cached = cache.get(key);
      if (cached !== undefined) return cached;

      const geometry = new TextGeometry(key === "question" ? "?" : String(key), {
        font,
        size: GLYPH_SIZE,
        depth: GLYPH_DEPTH,
        curveSegments: 10,
        bevelEnabled: false,
      });
      // Text is extruded from an origin at the baseline; centring it makes the
      // glyph sit in the middle of its cell.
      geometry.center();
      cache.set(key, geometry);
      return geometry;
    },
    dispose() {
      for (const geometry of cache.values()) geometry.dispose();
      cache.clear();
    },
  };
}

const GlyphContext = createContext<GlyphSet | null>(null);

/**
 * Loads the font (suspends) and shares the glyph cache with its children.
 *
 * The font is part of the scene, not of the interface, so it is only needed by
 * the number and question-mark layers.
 */
export function GlyphProvider({ children }: { readonly children: ReactNode }): ReactElement {
  const font = useLoader(FontLoader, assetUrl(ASSETS.font));
  const glyphs = useMemo(() => createGlyphSet(font), [font]);

  useEffect(() => () => glyphs.dispose(), [glyphs]);

  return <GlyphContext.Provider value={glyphs}>{children}</GlyphContext.Provider>;
}

/** Glyph cache of the surrounding {@link GlyphProvider}. */
export function useGlyphSet(): GlyphSet {
  const glyphs = useContext(GlyphContext);
  if (glyphs === null) throw new Error("useGlyphSet must be used inside <GlyphProvider>");
  return glyphs;
}

/**
 * Revealed cells that show a number.
 *
 * Cells with no adjacent mines stay empty, exactly like the prototype.
 */
function numberedCells(state: ClientGameState): { key: string; value: number; position: [number, number, number] }[] {
  const entries: { key: string; value: number; position: [number, number, number] }[] = [];
  for (const cell of state.cells) {
    if (!cell.isRevealed || cell.hasMine || cell.adjacentMines <= 0) continue;
    const center = cellCenter(cell.index, state.config.size);
    entries.push({ key: cellKey(cell.index), value: cell.adjacentMines, position: [center.x, center.y, center.z] });
  }
  return entries;
}

/**
 * Adjacency numbers of the revealed cells.
 *
 * The prototype only rotated the hover indicator; here the numbers are
 * billboarded towards the camera too, so the board stays readable from any
 * orbit angle (a deliberate improvement over the PoC).
 */
export function NumberGlyphs({ state }: { readonly state: ClientGameState }): ReactElement {
  const glyphs = useGlyphSet();
  const groupRef = useRef<Group>(null);
  const material = useMemo(
    () => new MeshStandardMaterial({ color: BOARD_COLORS.number, roughness: 0.45, metalness: 0.05 }),
    [],
  );

  useEffect(() => () => material.dispose(), [material]);

  const entries = useMemo(() => numberedCells(state), [state]);

  useFrame(({ camera }) => {
    const group = groupRef.current;
    if (group === null) return;
    for (const child of group.children) child.quaternion.copy(camera.quaternion);
  });

  return (
    <group ref={groupRef}>
      {entries.map((entry) => (
        <mesh
          key={entry.key}
          geometry={glyphs.geometryFor(entry.value)}
          material={material}
          position={entry.position}
        />
      ))}
    </group>
  );
}
