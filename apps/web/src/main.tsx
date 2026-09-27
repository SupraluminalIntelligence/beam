import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { convexUrl } from "./lib/convexUrl";
import "./tokens.css";
import "./app.css";

const client = new ConvexReactClient(convexUrl);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexAuthProvider client={client}>
      <App />
    </ConvexAuthProvider>
  </StrictMode>,
);
