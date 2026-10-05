/** Cheat sheet of mouse and keyboard controls, including the 3D digging rule. */
import type { ReactElement } from "react";

/** Static list of controls; no props, so it never re-renders. */
export function ControlsLegend(): ReactElement {
  return (
    <details className="legend" open>
      <summary>Controls</summary>
      <ul className="legend__list">
        <li>
          <kbd>Left click</kbd> dig a cell that is exposed
        </li>
        <li>
          <kbd>Alt</kbd> + click / <kbd>Middle click</kbd> toggle a flag
        </li>
        <li>
          <kbd>F</kbd> flag mode switches what a plain click does
        </li>
        <li>
          <kbd>R</kbd> new game on the current board
        </li>
        <li>
          <kbd>Right drag</kbd> orbit, <kbd>Wheel</kbd> zoom
        </li>
        <li>
          <kbd>Right click</kbd> a cell to re-centre the view
        </li>
      </ul>
      <p className="legend__rule">
        A cell only opens once it touches the surface or an already revealed cell — dig in from the outside.
      </p>
    </details>
  );
}
