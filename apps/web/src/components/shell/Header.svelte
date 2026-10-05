<script lang="ts">
  import { shell } from "#lib/stores/shell.svelte.ts";
  import Menu from "./Menu.svelte";

  let menuButton: HTMLButtonElement;
  let menu: HTMLElement | undefined = $state();

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
