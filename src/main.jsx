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

// Wait for React to render DOM elements before starting UI
function waitForElement(id, callback, attempts = 0) {
  const el = document.getElementById(id);
  if (el) {
    callback();
  } else if (attempts < 50) {
    setTimeout(() => waitForElement(id, callback, attempts + 1), 100);
  } else {
    console.error(`Failed to find element #${id} after 5 seconds`);
  }
}

waitForElement('dropzone', () => {
  startUI().catch((e) => {
    console.error(e);
    toast("Failed to start Helia/libp2p");
  });
});
