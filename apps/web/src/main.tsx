import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./app.css";

const url = import.meta.env["VITE_CONVEX_URL"] as string;
const client = new ConvexReactClient(url);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexAuthProvider client={client}>
      <App />
    </ConvexAuthProvider>
  </StrictMode>,
);
