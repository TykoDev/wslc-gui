import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App.tsx";
import { AppProvider } from "./state.tsx";
import { initToken } from "./lib/api.ts";
import "./theme/global.css";

initToken(); // read #t=… fragment BEFORE the router touches the URL

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AppProvider>
  </StrictMode>,
);
