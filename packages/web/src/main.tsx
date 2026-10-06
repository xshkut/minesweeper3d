/**
 * Entry point: mounts the root component. The session (and the room it may
 * belong to) is created by {@link AppRoot}, not here.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppRoot } from "./AppRoot";
import "./styles.css";

const container = document.getElementById("root");
if (container === null) throw new Error("#root is missing from index.html");

const root = createRoot(container);

root.render(
  <StrictMode>
    <AppRoot />
  </StrictMode>,
);

if (import.meta.hot !== undefined) {
  import.meta.hot.dispose(() => root.unmount());
}
