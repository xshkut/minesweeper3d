/** Cheat sheet of mouse, keyboard and touch controls, including the 3D digging rule. */
import type { ReactElement } from "react";

/** Static list of controls; no props, so it never re-renders. */
export function ControlsLegend(): ReactElement {
  return (
    <details className="legend" open>
      <summary>Controls</summary>
      <ul className="legend__list">
        <li>
          <kbd>Left click</kbd> or <kbd>Tap</kbd> a cell: dig it if it is exposed, or use the selected tool
        </li>
        <li>
          <kbd>Alt</kbd> + click, <kbd>Middle click</kbd> or <kbd>Hold</kbd> a cell cycles flag, question mark,
          nothing
        </li>
        <li>
          <kbd>1</kbd> dig, <kbd>2</kbd>/<kbd>F</kbd> mark, <kbd>3</kbd>/<kbd>Q</kbd> detector
        </li>
        <li>
          <kbd>?</kbd> marks a cell you are unsure about; a free reveal spends a charge to say whether a bomb is inside
        </li>
        <li>
          <kbd>R</kbd> new game on the current board
        </li>
        <li>
          <kbd>Right drag</kbd> or <kbd>Drag</kbd> orbits the board, <kbd>Wheel</kbd> or <kbd>Pinch</kbd> zooms
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
