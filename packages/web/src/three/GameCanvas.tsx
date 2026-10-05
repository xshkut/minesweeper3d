/**
 * The WebGL half of the app: a fullscreen `<Canvas>` plus the DOM chrome that
 * belongs to it (loading overlay and the WebGL failure panel).
 *
 * The canvas is mounted once and never re-created; board changes are handled by
 * the scene itself, which keeps the camera where the player left it.
 */
import { useSyncExternalStore } from "react";
import type { ReactElement } from "react";
import { Canvas } from "@react-three/fiber";
import type { CellIndex, ClientGameState } from "@minesweeper3d/game-core";
import { BoardScene } from "./BoardScene";
import { ErrorBoundary } from "./ErrorBoundary";
import { sceneLoading } from "./loading";
import type { BlockedReason } from "./useBoardPointer";

/** Props of {@link GameCanvas}. */
export interface GameCanvasProps {
  readonly state: ClientGameState | null;
  readonly flagMode: boolean;
  readonly resetToken: number;
  readonly onReveal: (cell: CellIndex) => void;
  readonly onFlag: (cell: CellIndex) => void;
  readonly onBlocked: (cell: CellIndex, reason: BlockedReason) => void;
}

/** Field of view, near and far planes ported from the prototype. */
const CAMERA = { fov: 75, near: 0.1, far: 5000, position: [130, 130, 130] as [number, number, number] };

/** Fullscreen 3D view with its loading and error overlays. */
export function GameCanvas(props: GameCanvasProps): ReactElement {
  return (
    <div className="canvas-shell" data-testid="canvas-shell">
      <ErrorBoundary
        fallback={(error) => (
          <div className="canvas-error" role="alert" data-testid="canvas-error">
            <h2>3D view unavailable</h2>
            <p>{error.message}</p>
            <p className="canvas-error__hint">
              The game is still playable with the controls on the left; WebGL is only needed for the board.
            </p>
          </div>
        )}
      >
        <Canvas
          dpr={[1, 2]}
          gl={{ antialias: true, powerPreference: "high-performance" }}
          camera={CAMERA}
          // The board sits on the origin and the camera orbits it, so a static
          // scene graph is enough; three still re-renders every frame because
          // the rig animates the camera.
          frameloop="always"
        >
          <BoardScene
            state={props.state}
            flagMode={props.flagMode}
            resetToken={props.resetToken}
            onReveal={props.onReveal}
            onFlag={props.onFlag}
            onBlocked={props.onBlocked}
          />
        </Canvas>
      </ErrorBoundary>
      <LoadingOverlay />
    </div>
  );
}

/** Shows progress while assets load and the first frame is being prepared. */
function LoadingOverlay(): ReactElement | null {
  const loading = useSyncExternalStore(sceneLoading.subscribe, sceneLoading.getSnapshot, sceneLoading.getSnapshot);
  if (loading.ready && loading.pending === 0) return null;

  return (
    <div className="loading" role="status" data-testid="scene-loading">
      <div className="loading__spinner" aria-hidden="true" />
      <p>{loading.pending > 0 ? "Loading assets…" : "Preparing the board…"}</p>
    </div>
  );
}
