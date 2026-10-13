<script lang="ts">
  import { shell } from "#lib/stores/shell.svelte.ts";
  import { getFocusStatus, type FocusStatus } from "#lib/api/shell.ts";
  import { onMount } from "svelte";
  import Menu from "./Menu.svelte";

  let menuButton: HTMLButtonElement;
  let menu: HTMLElement | undefined = $state();
  let focus: FocusStatus | null = $state(null);
  let now = $state(Date.now());
  function remainingSeconds(status: FocusStatus | null, at: number): number {
    return status?.active && status.until
      ? Math.max(0, Math.ceil((Date.parse(status.until) - at) / 1000))
      : 0;
  }
  const remaining = $derived(remainingSeconds(focus, now));
  const countdown = $derived(
    `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`,
  );

  onMount(() => {
    let alive = true;
    const refresh = () => {
      void getFocusStatus()
        .then((value) => {
          if (alive) focus = value;
        })
        .catch(() => undefined);
    };
    refresh();
    const clock = setInterval(() => (now = Date.now()), 1000);
    const poll = setInterval(refresh, 30_000);
    window.addEventListener("nova-focus-updated", refresh);
    return () => {
      alive = false;
      clearInterval(clock);
      clearInterval(poll);
      window.removeEventListener("nova-focus-updated", refresh);
    };
  });

  function onDocumentClick(event: MouseEvent) {
    const target = event.target as Node;
    if (
      shell.menuOpen &&
      !menu?.contains(target) &&
      !menuButton.contains(target)
    )
      shell.menuOpen = false;
  }

  function onDocumentKey(event: KeyboardEvent) {
    if (!shell.menuOpen || !menu) return;
    if (event.key === "Escape") {
      shell.menuOpen = false;
      menuButton.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const items = [
        ...menu.querySelectorAll<HTMLElement>(".menu-item:not(:disabled)"),
      ];
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = event.key === "ArrowDown" ? at + 1 : at - 1;
      items[(next + items.length) % items.length]?.focus();
    }
  }
</script>

<svelte:document onclick={onDocumentClick} onkeydown={onDocumentKey} />

<header>
  <h1 class="wordmark">NOVA</h1>
  <div class="head-right">
    {#if focus?.active && remaining > 0}
      <span
        class="focus-clock"
        aria-label={`${focus.workBlock ? "Werkblok" : "Focus"}: ${countdown} resterend`}
        title={focus.workBlock ? "Werkblok loopt" : "Focusmodus actief"}
        >{focus.workBlock ? "Werkblok" : "Focus"} {countdown}</span
      >
    {/if}
    <button
      type="button"
      class="code-btn"
      aria-expanded={shell.codeOpen}
      onclick={() => (shell.codeOpen = !shell.codeOpen)}>Code</button
    >
    <span class="sys-dot" aria-hidden="true"></span>
    <span
      class="wake-dot"
      id="wakeDot"
      hidden={!shell.wakeActive}
      title="Luistert naar Hey NOVA"
    ></span>
    <button
      class="menu-btn"
      id="menuButton"
      type="button"
      aria-haspopup="menu"
      aria-expanded={shell.menuOpen}
      aria-controls="menu"
      aria-label="Menu"
      title="Menu"
      bind:this={menuButton}
      onclick={(event) => {
        event.stopPropagation();
        shell.menuOpen = !shell.menuOpen;
      }}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="5" cy="12" r="1.6" />
        <circle cx="12" cy="12" r="1.6" />
        <circle cx="19" cy="12" r="1.6" />
      </svg>
    </button>
    <Menu bind:element={menu} />
  </div>
  <p id="routingNotice" role="status">{shell.routingNotice}</p>
</header>
