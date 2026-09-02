import { ConvexProvider, ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./tokens.css";

const url = import.meta.env["VITE_CONVEX_URL"] as string | undefined;
const client = url ? new ConvexReactClient(url) : null;

createRoot(document.getElementById("root")!).render(
  <StrictMode>{client ? <ConvexProvider client={client}><App /></ConvexProvider> : <App />}</StrictMode>,
);
