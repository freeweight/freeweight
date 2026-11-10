import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/base.css";
import { transportReady } from "./api";
import { App } from "./app";
import { Boundary } from "./ui/boundary";

void transportReady.then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Boundary>
        <App />
      </Boundary>
    </StrictMode>,
  );
});
