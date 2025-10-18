import { createRoot } from "react-dom/client";
import App from "./App";
import { AppProvider } from "./context/AppProvider";

const mount = () => {
  const container = document.getElementById("app");
  if (!container) {
    console.error("UXP panel mount point not found");
    return;
  }
  const root = createRoot(container);
  root.render(
    <AppProvider>
      <App />
    </AppProvider>
  );
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}
