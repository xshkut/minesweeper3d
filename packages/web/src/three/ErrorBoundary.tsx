/**
 * Minimal error boundary used to degrade individual 3D pieces instead of the
 * whole canvas: a missing mine model falls back to a ball, a missing cubemap
 * keeps the plain background, a broken WebGL context shows a readable panel.
 */
import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

/** Props of {@link ErrorBoundary}. */
export interface ErrorBoundaryProps {
  readonly children: ReactNode;
  /** Rendered instead of the children once something threw. */
  readonly fallback: ReactNode | ((error: Error) => ReactNode);
  /** Called with the caught error, e.g. to surface it in the HUD. */
  readonly onError?: (error: Error) => void;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

/** Catches render errors of its children. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.props.onError?.(error);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return typeof this.props.fallback === "function" ? this.props.fallback(error) : this.props.fallback;
  }
}
