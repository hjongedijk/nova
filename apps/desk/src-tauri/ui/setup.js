/* global document, window */
// First-run page: stores the NOVA address through the one command this window may call.
(() => {
  const form = document.getElementById("form");
  const input = document.getElementById("url");
  const message = document.getElementById("message");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.textContent = "";
    try {
      await window.__TAURI__.core.invoke("desk_set_url", { url: input.value });
      message.style.color = "#7fd6ff";
      message.textContent = "Opgeslagen. NOVA Desk start.";
    } catch (error) {
      message.style.color = "#f2a65a";
      message.textContent = String(error);
    }
  });
})();
