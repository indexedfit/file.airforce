import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { startUI } from "./bootstrap.js";
import { toast } from "./ui.js";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing #root element");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

startUI().catch((e) => {
  console.error(e);
  toast("Failed to start Helia/libp2p");
});
