import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

// Offline fallback for the installed (Home Screen) app. Production only so the
// worker never interferes with Vite dev serving; see client/public/sw.js for
// what it does (and deliberately does not) cache. Browsers only allow service
// workers on secure origins (HTTPS, or localhost), so over a plain-http LAN
// address this quietly stays off and only the offline page is lost.
if (import.meta.env.PROD && window.isSecureContext && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Registration failing (e.g. plain-http origin) only loses the offline
      // page; the app itself works fine without it.
    });
  });
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
