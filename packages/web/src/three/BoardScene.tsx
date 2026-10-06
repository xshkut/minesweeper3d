/**
 * The 3D scene: lights, background cubemap, camera rig and - once the state and
 * the crate texture are available - the board itself.
 *
 * Everything here lives inside `<Canvas>`, so it must never suspend the DOM:
 * the loading overlay is driven by the `sceneLoading` store instead.
 */
import { Suspense, useEffect, useMemo, useRef } from "react";
import type { ReactElement } from "react";
import { useFrame, useLoader, useThree } from "@react-three/fiber";
import { CubeTextureLoader, TextureLoader } from "three";
import type { CellIndex, ClientGameState } from "@minesweeper3d/game-core";
import { ASSETS, assetUrl, cubemapUrls } from "./assets";
import { BOARD_COLORS } from "./board";
import { CellLayer } from "./CellLayer";
import { ErrorBoundary } from "./ErrorBoundary";
import { createHoverSlot } from "./hover";
import type { HoverSlot } from "./hover";
import { sceneLoading } from "./loading";
import { useCameraRig } from "./useCameraRig";
import type { BlockedReason, BoardTool } from "./useBoardPointer";
import type { Point3 } from "./orbit";
import type { PresenceView } from "../session/presence";

/** Props of {@link BoardScene}. */
export interface BoardSceneProps {
  /** `null` while the session is still loading (or failed). */
  readonly state: ClientGameState | null;
  readonly tool: BoardTool;
  /** Bumped by the "reset view" button to re-frame the camera. */
  readonly resetToken: number;
  readonly onReveal: (cell: CellIndex) => void;
  readonly onMark: (cell: CellIndex) => void;
  readonly onProbe: (cell: CellIndex) => void;
  readonly onBlocked: (cell: CellIndex, reason: BlockedReason) => void;
  /** The other seats of the room, to draw their pointers; absent offline. */
  readonly presence?: PresenceView | undefined;
  /** Reports where this player is pointing, when the session cares. */
  readonly onCursor?: ((cell: CellIndex | null) => void) | undefined;
}

/** Scene contents; must be rendered inside `<Canvas>`. */
export function BoardScene(props: BoardSceneProps): ReactElement {
  const { state, tool, resetToken, onReveal, onMark, onProbe, onBlocked, presence, onCursor } = props;
  const hover = useMemo(createHoverSlot, []);
  const size = state?.config.size ?? null;
  const rig = useCameraRig({ size, resetToken });
  const onRecenter = rig.recenter;

  return (
    <>
      <color attach="background" args={[BOARD_COLORS.background]} />
      <SceneLights />
      <ErrorBoundary fallback={null}>
        <Suspense fallback={null}>
          <SceneBackground />
        </Suspense>
      </ErrorBoundary>
      <ReadySignal />

      {state !== null && (
        <ErrorBoundary fallback={null}>
          <Suspense fallback={<LoadingProbe />}>
            <Board
              key={`${state.config.size.x}x${state.config.size.y}x${state.config.size.z}`}
              state={state}
              tool={tool}
              hover={hover}
              pointer={rig.pointer}
              onReveal={onReveal}
              onMark={onMark}
              onProbe={onProbe}
              onBlocked={onBlocked}
              onRecenter={onRecenter}
              presence={presence}
              onCursor={onCursor}
            />
          </Suspense>
        </ErrorBoundary>
      )}
    </>
  );
}

interface BoardProps {
  readonly state: ClientGameState;
  readonly tool: BoardTool;
  readonly hover: HoverSlot;
  readonly pointer: ReturnType<typeof useCameraRig>["pointer"];
  readonly onReveal: (cell: CellIndex) => void;
  readonly onMark: (cell: CellIndex) => void;
  readonly onProbe: (cell: CellIndex) => void;
  readonly onBlocked: (cell: CellIndex, reason: BlockedReason) => void;
  readonly onRecenter: (point: Point3) => void;
  readonly presence?: PresenceView | undefined;
  readonly onCursor?: ((cell: CellIndex | null) => void) | undefined;
}

/** Board geometry; suspends until the crate texture is there. */
function Board(props: BoardProps): ReactElement {
  const texture = useLoader(TextureLoader, assetUrl(ASSETS.crateTexture));
  return <CellLayer {...props} texture={texture} />;
}

/**
 * Ambient plus two directional lights, ported from the prototype.
 *
 * Intensities are higher than the prototype's defaults because three.js uses
 * physical light units since r155 and the glyphs would otherwise look black.
 */
function SceneLights(): ReactElement {
  return (
    <>
      <ambientLight color={BOARD_COLORS.ambient} intensity={2.2} />
      <directionalLight color={0xffffff} intensity={2.4} position={[-1, 1, 1]} />
      <directionalLight color={0xffffff} intensity={2.4} position={[1, 1, 1]} />
    </>
  );
}

/**
 * Cubemap background.
 *
 * Loads on its own (no shared Suspense) so a missing cubemap leaves the grey
 * background in place instead of blocking the board.
 */
function SceneBackground(): ReactElement {
  const scene = useThree((three) => three.scene);
  // One nested array: r3f's `useLoader` reads a flat array as *several* loads,
  // while `CubeTextureLoader` wants the six faces as a single input.
  const faces: string[][] = [cubemapUrls()];
  const textures = useLoader(CubeTextureLoader, faces);
  const texture = textures[0];

  useEffect(() => {
    if (texture === undefined) return undefined;
    scene.background = texture;
    return () => {
      scene.background = null;
    };
  }, [scene, texture]);

  return <></>;
}

/** Marks the scene ready after its first rendered frame. */
function ReadySignal(): ReactElement {
  const reported = useRef(false);
  useFrame(() => {
    if (reported.current) return;
    reported.current = true;
    sceneLoading.markReady();
  });
  return <></>;
}

/**
 * Suspense fallback of the board.
 *
 * It reports the pending asset group to the DOM overlay: mounting the fallback
 * means "still loading", unmounting it means "done".
 */
function LoadingProbe(): ReactElement {
  useEffect(() => {
    sceneLoading.begin();
    return () => sceneLoading.end();
  }, []);
  return <></>;
}
