import App from "./App";
import { createRoot } from "react-dom/client";
import "./index.css";

// Apply dark mode from system preference on load
if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
  document.documentElement.classList.add("dark");
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
