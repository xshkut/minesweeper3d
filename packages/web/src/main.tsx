/**
 * Entry point: creates the session described by the URL, publishes the
 * automation hook used by the e2e test, and renders the app.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createSession } from "./session/createSession";
import { installAutomationHook } from "./session/store";
import "./styles.css";

const session = createSession();

// `window.__minesweeper3d` drives a real game from outside (e2e smoke test).
installAutomationHook(session);

const container = document.getElementById("root");
if (container === null) throw new Error("#root is missing from index.html");

createRoot(container).render(
  <StrictMode>
    <App session={session} />
  </StrictMode>,
);

if (import.meta.hot !== undefined) {
  import.meta.hot.dispose(() => session.dispose());
}
