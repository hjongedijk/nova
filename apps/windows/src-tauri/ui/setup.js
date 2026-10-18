/* global document, window */
(() => {
  const element = (id) => document.getElementById(id);
  const invoke = (name, args) => window.__TAURI__.core.invoke(name, args);
  const message = element("message");
  function form(id, action) {
    element(id).addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = event.submitter;
      button.disabled = true;
      try {
        message.textContent = await action();
      } catch (error) {
        message.textContent = String(error);
      } finally {
        button.disabled = false;
      }
    });
  }
  form("form", async () => {
    await invoke("desk_set_url", { url: element("url").value });
    return "Adres opgeslagen. NOVA is geopend.";
  });
  form("network", async () => {
    await invoke("agent_configure_network", {
      source: element("source").value.trim(),
    });
    return "Windows staat de verbinding vanaf je NOVA-server toe.";
  });
  form("pair", async () => {
    element("code").type = "password";
    element("code").value = await invoke("agent_pair_code", {
      address: element("address").value,
    });
    return "Kopieer de code naar NOVA. Bewaar hem als een wachtwoord.";
  });
  form("legacy", async () => {
    await invoke("agent_retire_legacy", {
      directory: element("directory").value.trim(),
    });
    return "Oude agent uitgeschakeld. Bestanden blijven bewaard.";
  });
  element("import").addEventListener("click", async () => {
    try {
      await invoke("agent_import_legacy", {
        directory: element("directory").value.trim(),
      });
      element("code").value = "";
      await refresh();
      message.textContent =
        "Instellingen geïmporteerd. De vorige config is bewaard als config.json.before-import.";
    } catch (error) {
      message.textContent = String(error);
    }
  });
  element("copy").addEventListener("click", async () => {
    if (!element("code").value) return;
    try {
      await navigator.clipboard.writeText(element("code").value);
      message.textContent = "Koppelcode gekopieerd.";
    } catch {
      element("code").type = "text";
      element("code").select();
      message.textContent = "Kopieer de geselecteerde code met Ctrl+C.";
    }
  });
  async function refresh() {
    const info = await invoke("agent_setup_info");
    element("url").value = info.url || "";
    element("source").value = info.source || "";
    element("address").replaceChildren();
    for (const address of info.addresses) {
      const option = document.createElement("option");
      option.value = address;
      option.textContent = address;
      element("address").append(option);
    }
    if (!info.addresses.length)
      message.textContent =
        "Geen netwerkadres gevonden. Verbind deze pc met je netwerk en open dit venster opnieuw.";
    if (info.error) message.textContent = info.error;
  }
  function renderUpdate(state) {
    const busy = ["checking", "downloading", "installing"].includes(
      state.phase,
    );
    element("check-update").disabled = busy;
    element("install-update").hidden = state.phase !== "available";
    element("install-update").disabled = busy;
    element("update-notes").textContent =
      state.phase === "available" ? state.notes || "" : "";
    const progress = element("update-progress");
    progress.hidden = state.phase !== "downloading";
    if (state.total > 0) {
      progress.max = state.total;
      progress.value = state.downloaded;
    } else {
      progress.removeAttribute("value");
    }
    element("update-message").textContent =
      {
        idle: `Versie ${state.currentVersion}. Nog niet gecontroleerd.`,
        checking: "Nieuwe versies zoeken op GitHub…",
        current: `Je gebruikt de nieuwste versie (${state.currentVersion}).`,
        available: `NOVA ${state.version} is beschikbaar.`,
        downloading: `Update downloaden: ${Math.round(state.downloaded / 1024 / 1024)} MB`,
        installing: "Update installeren. NOVA sluit en wordt opnieuw gestart.",
        failed: state.error || "Update mislukt. Probeer later opnieuw.",
      }[state.phase] || "";
  }
  for (const [id, command] of [
    ["check-update", "agent_check_update"],
    ["install-update", "agent_install_update"],
  ]) {
    element(id).addEventListener("click", async () => {
      element(id).disabled = true;
      try {
        await invoke(command);
      } catch (error) {
        element("update-message").textContent = String(error);
      } finally {
        renderUpdate(await invoke("agent_update_status"));
      }
    });
  }
  window.__TAURI__.event
    .listen("nova-update-state", (event) => renderUpdate(event.payload))
    .then(() => invoke("agent_update_status"))
    .then(renderUpdate)
    .catch(() => {
      element("update-message").textContent =
        "Updatecontrole is niet beschikbaar.";
    });
  refresh().catch((error) => {
    message.textContent = String(error);
  });
})();
