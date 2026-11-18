import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyFont, loadFont } from "./lib/fonts";
import "./styles.css";

applyFont(loadFont());
createRoot(document.getElementById("root")!).render(<App />);
