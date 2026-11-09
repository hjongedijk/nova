(() => {
  const element = (id) => document.getElementById(id);
  const invoke = (name, args) => window.__TAURI__.core.invoke(name, args);
  const message = element("message");
  let state = null;
  let toastTimer = 0;

  function say(text) {
    clearTimeout(toastTimer);
    message.textContent = text || "";
    message.hidden = !text;
    if (text) toastTimer = setTimeout(() => (message.hidden = true), 8000);
  }

  // An application window, not a browser tab: no reload, print, find, zoom or source view.
  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    const ctrl = event.ctrlKey || event.metaKey;
    if (
      key === "f5" ||
      key === "f7" ||
      key === "f12" ||
      (ctrl &&
        ["r", "p", "f", "g", "u", "s", "j", "h", "+", "-", "=", "0"].includes(
          key,
        )) ||
      (ctrl && event.shiftKey && ["i", "c", "j"].includes(key)) ||
      (event.altKey && ["arrowleft", "arrowright"].includes(key))
    )
      event.preventDefault();
    if (ctrl && /^[1-4]$/.test(event.key)) {
      event.preventDefault();
      show(["overview", "display", "pair", "system"][Number(event.key) - 1]);
    }
  });
  document.addEventListener(
    "wheel",
    (event) => {
      if (event.ctrlKey) event.preventDefault();
    },
    { passive: false },
  );
  document.addEventListener("contextmenu", (event) => {
    if (!event.target.closest("input, textarea")) event.preventDefault();
  });
  document.addEventListener("dragstart", (event) => event.preventDefault());

  function show(page) {
    for (const button of document.querySelectorAll(".nav")) {
      if (button.dataset.page === page)
        button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    for (const section of document.querySelectorAll(".page"))
      section.hidden = section.id !== `page-${page}`;
    if (page === "pair")
      refreshAddresses().catch((error) => say(String(error)));
  }
  for (const button of document.querySelectorAll(".nav"))
    button.addEventListener("click", () => show(button.dataset.page));
  element("go-updates").addEventListener("click", () => show("system"));

  async function act(button, work, done) {
    if (button) button.disabled = true;
    try {
      const result = await work();
      if (done) say(done);
      return result;
    } catch (error) {
      say(String(error));
    } finally {
      if (button) button.disabled = false;
    }
  }

  function setStatus(id, text, tone) {
    const node = element(id);
    node.textContent = text;
    node.className = `status ${tone || ""}`;
  }

  function render(next) {
    state = next;
    element("app-version").textContent = `voor Windows · v${next.version}`;
    if (!next.url) setStatus("status-server", "Nog niet ingesteld", "warn");
    else if (!next.listening) setStatus("status-server", "Poort bezet", "bad");
    else setStatus("status-server", "Klaar voor NOVA", "good");
    element("status-server-detail").textContent = next.agentError
      ? next.agentError
      : next.url
        ? `${next.url} · poort ${next.port}`
        : "Vul het adres in bij Koppelen.";

    setStatus(
      "status-control",
      next.paused ? "Gepauzeerd door jou" : "Actief: NOVA mag deze pc bedienen",
      next.paused ? "warn" : "good",
    );
    element("pause").textContent = next.paused
      ? "Hervatten"
      : "Pauzeren (noodstop)";

    const helperMode = next.mode === "helper" || next.mode === "both";
    setStatus(
      "status-helper",
      !helperMode
        ? "Uit in deze weergave"
        : next.helperWanted
          ? "Zichtbaar"
          : "Verborgen",
      helperMode && next.helperWanted ? "good" : "",
    );
    element("helper-toggle").textContent = next.helperWanted
      ? "Helper verbergen"
      : "Helper tonen";
    element("helper-toggle").disabled = !helperMode || !next.url;
    element("login").disabled = !helperMode || !next.url;
    element("open-browser").disabled = !next.url;

    const warnings = [...(next.hotkeyWarnings || [])];
    if (!next.emergencyReady)
      warnings.push(
        "De noodstop Ctrl+Alt+Shift+K kon niet worden gekoppeld (een ander programma gebruikt hem). Pauzeren kan altijd via het pictogram bij de klok.",
      );
    element("warnings").replaceChildren(
      ...warnings.map((text) => {
        const p = document.createElement("p");
        p.textContent = text;
        return p;
      }),
    );

    for (const radio of document.querySelectorAll('input[name="mode"]'))
      radio.checked = radio.value === next.mode;
    const select = element("helper-display");
    select.replaceChildren(
      ...next.displays.map((d) => {
        const option = document.createElement("option");
        option.value = String(d.index);
        option.textContent = `Scherm ${d.index} (${d.width}×${d.height}${d.primary ? ", hoofdscherm" : ""})`;
        option.selected = d.index === next.helperDisplay;
        return option;
      }),
    );
    select.disabled = !helperMode;
    element("wallpapers").replaceChildren(
      ...next.displays.map((d) => {
        const label = document.createElement("label");
        label.className = "switch";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = d.wallpaper;
        box.disabled = next.mode === "helper";
        box.addEventListener("change", () =>
          act(box, () =>
            invoke("app_set_wallpaper", { index: d.index, on: box.checked }),
          ),
        );
        const text = document.createElement("span");
        text.textContent = `Scherm ${d.index} (${d.width}×${d.height}${d.primary ? ", hoofdscherm" : ""})`;
        label.append(box, text);
        return label;
      }),
    );

    element("autostart").checked = next.autostart;
    element("elevation").textContent = next.elevated
      ? "NOVA draait met beheerrechten en kan ook vensters van beheerprogramma's bedienen."
      : "NOVA draait zonder beheerrechten: vensters van programma's die als beheerder draaien kan NOVA niet bedienen.";
    if (document.activeElement !== element("url"))
      element("url").value = next.url || "";
  }

  async function refresh() {
    render(await invoke("app_state"));
  }

  async function refreshAddresses() {
    const info = await invoke("agent_setup_info");
    const select = element("address");
    const previous = select.value;
    select.replaceChildren(
      ...info.addresses.map((address) => {
        const option = document.createElement("option");
        option.value = address;
        option.textContent = address;
        option.selected = address === previous;
        return option;
      }),
    );
    if (!info.addresses.length)
      say(
        "Geen netwerkadres gevonden. Verbind deze pc met je netwerk en probeer opnieuw.",
      );
  }

  element("pause").addEventListener("click", (event) =>
    act(event.currentTarget, () =>
      invoke("app_set_paused", { paused: !state?.paused }),
    ),
  );
  element("helper-toggle").addEventListener("click", (event) =>
    act(event.currentTarget, () =>
      invoke("app_set_helper_visible", { visible: !state?.helperWanted }),
    ),
  );
  element("login").addEventListener("click", (event) =>
    act(
      event.currentTarget,
      () => invoke("app_show_login"),
      "De helper staat groot open om in te loggen.",
    ),
  );
  element("open-browser").addEventListener("click", (event) =>
    act(event.currentTarget, () => invoke("app_open_browser")),
  );
  for (const radio of document.querySelectorAll('input[name="mode"]'))
    radio.addEventListener("change", () => {
      if (radio.checked)
        act(null, () => invoke("app_set_mode", { mode: radio.value }));
    });
  element("helper-display").addEventListener("change", (event) =>
    act(null, () =>
      invoke("app_set_helper_display", {
        index: Number(event.currentTarget.value),
      }),
    ),
  );
  element("autostart").addEventListener("change", (event) => {
    const box = event.currentTarget;
    act(
      box,
      () => invoke("app_set_autostart", { on: box.checked }),
      box.checked
        ? "NOVA start voortaan met Windows."
        : "NOVA start niet meer met Windows.",
    ).finally(() => refresh().catch(() => {}));
  });

  function form(id, action) {
    element(id).addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = await act(event.submitter, action);
      if (text) say(text);
    });
  }
  form("form", async () => {
    await invoke("desk_set_url", { url: element("url").value });
    return "Adres opgeslagen. NOVA opent de helper.";
  });
  form("network", async () => {
    await invoke("agent_configure_network");
    return "Windows staat de verbinding met NOVA toe.";
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
  element("import").addEventListener("click", (event) =>
    act(
      event.currentTarget,
      async () => {
        await invoke("agent_import_legacy", {
          directory: element("directory").value.trim(),
        });
        element("code").value = "";
        await refresh();
      },
      "Instellingen geïmporteerd. De vorige config is bewaard als config.json.before-import.",
    ),
  );
  element("copy").addEventListener("click", async () => {
    if (!element("code").value) return;
    try {
      await navigator.clipboard.writeText(element("code").value);
      say("Koppelcode gekopieerd.");
    } catch {
      element("code").type = "text";
      element("code").select();
      say("Kopieer de geselecteerde code met Ctrl+C.");
    }
  });

  function renderUpdate(update) {
    const busy = ["checking", "downloading", "installing"].includes(
      update.phase,
    );
    element("check-update").disabled = busy;
    element("install-update").hidden = update.phase !== "available";
    element("install-update").disabled = busy;
    element("update-dot").hidden = update.phase !== "available";
    element("update-notes").textContent =
      update.phase === "available" ? update.notes || "" : "";
    const progress = element("update-progress");
    progress.hidden = update.phase !== "downloading";
    if (update.total > 0) {
      progress.max = update.total;
      progress.value = update.downloaded;
    } else {
      progress.removeAttribute("value");
    }
    const current = String(update.currentVersion).replace(/^v/, "");
    const text =
      {
        idle: `Versie ${current}. Nog niet gecontroleerd.`,
        checking: "Nieuwe versies zoeken…",
        current: `Je gebruikt de nieuwste versie (${current}).`,
        available: `NOVA ${update.version} is beschikbaar.`,
        downloading: `Update downloaden: ${Math.round(update.downloaded / 1024 / 1024)} MB`,
        installing: "Update installeren. NOVA sluit en start opnieuw.",
        failed:
          update.error ||
          "Update mislukt. NOVA probeert het later zelf opnieuw.",
      }[update.phase] || "";
    element("update-message").textContent = text;
    setStatus(
      "status-version",
      update.phase === "available"
        ? `v${current} · update ${update.version} klaar`
        : `v${current}`,
      update.phase === "available" ? "warn" : "",
    );
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

  const events = window.__TAURI__.event;
  events
    .listen("nova-app-state", (event) => render(event.payload))
    .catch(() => {});
  events
    .listen("nova-update-state", (event) => renderUpdate(event.payload))
    .then(() => invoke("agent_update_status"))
    .then(renderUpdate)
    .catch(() => {
      element("update-message").textContent =
        "Updatecontrole is niet beschikbaar.";
    });
  refresh()
    .then(() => {
      if (!state.url) show("pair");
    })
    .catch((error) => say(String(error)));
  // Helper visibility and display changes can happen elsewhere (tray, NOVA); keep the overview honest.
  setInterval(() => {
    if (!document.hidden) refresh().catch(() => {});
  }, 5000);
})();
