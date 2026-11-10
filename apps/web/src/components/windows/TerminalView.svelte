<script lang="ts">
  /*
   * A live terminal: the command is typed at the prompt, then the output streams in as it arrives (ANSI colours,
   * scrollback). Read-only; xterm loads only when a terminal window opens.
   */
  import "@xterm/xterm/css/xterm.css";
  import { onDestroy, onMount } from "svelte";
  import Icon from "./Icon.svelte";
  import type { NovaWin } from "#lib/windows/manager.ts";
  import { terminalText, watchTerminal } from "#lib/windows/terminals.ts";

  let { win }: { win: NovaWin } = $props();

  let host = $state<HTMLDivElement | null>(null);
  let copied = $state(false);
  let elapsed = $state(0);
  const id = $derived(String(win.data.terminal ?? ""));
  const running = $derived(win.phase === "running");
  const exitCode = $derived(
    typeof win.data.exitCode === "number" ? win.data.exitCode : null,
  );
  const duration = $derived(
    typeof win.data.durationMs === "number" ? win.data.durationMs : null,
  );

  const seconds = (ms: number) =>
    ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;

  let dispose: (() => void)[] = [];
  onMount(() => {
    let cancelled = false;
    const started = Number(win.data.startedAt) || Date.now();
    const tick = setInterval(() => (elapsed = Date.now() - started), 250);
    dispose.push(() => clearInterval(tick));
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (cancelled || !host) return;
      const term = new Terminal({
        disableStdin: true,
        convertEol: true,
        cursorBlink: false,
        scrollback: 5000,
        fontFamily:
          'ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace',
        fontSize: 12.5,
        lineHeight: 1.25,
        theme: {
          background: "#05060d",
          foreground: "#e9e6f5",
          cursor: "#6ddcf5",
          selectionBackground: "#6ddcf544",
          black: "#1b1d2e",
          red: "#ff7a5c",
          green: "#8fe8c4",
          yellow: "#ffcf6b",
          blue: "#7aa8ff",
          magenta: "#c79bff",
          cyan: "#6ddcf5",
          white: "#e9e6f5",
          brightBlack: "#5d5a7a",
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      fit.fit();
      const observer = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          /* hidden */
        }
      });
      observer.observe(host);
      dispose.push(
        () => observer.disconnect(),
        () => term.dispose(),
      );

      const prompt = `\x1b[38;2;109;220;245m${win.data.host ? `${win.data.host}` : "nova"}\x1b[0m \x1b[38;2;138;135;168m$\x1b[0m `;
      term.write(prompt);
      const command = String(win.data.command ?? "");
      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      // Type the command like a person, quickly: at most ~0.9 s whatever its length.
      const step = reduce
        ? command.length
        : Math.max(1, Math.ceil(command.length / 45));
      for (let i = 0; i < command.length && !cancelled; i += step) {
        term.write(command.slice(i, i + step));
        if (!reduce) await new Promise((r) => setTimeout(r, 18));
      }
      term.write("\r\n");
      if (cancelled) return;
      dispose.push(watchTerminal(id, (chunk) => term.write(chunk)));
    })();
    dispose.push(() => (cancelled = true));
  });
  onDestroy(() => dispose.forEach((fn) => fn()));

  async function copy() {
    // eslint-disable-next-line no-control-regex
    const text = `$ ${win.data.command ?? ""}\n${terminalText(id).replace(/\u001b\[[0-9;]*m/g, "")}`;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => (copied = false), 1400);
    } catch {
      copied = false;
    }
  }
</script>

<div class="terminal">
  <div class="screen" bind:this={host}></div>
  <div class="foot">
    {#if running}
      <span class="state run"
        ><span class="dot"></span>bezig · {seconds(elapsed)}</span
      >
    {:else}
      <span class="state" class:bad={win.phase === "failed"}>
        {exitCode === null
          ? win.phase === "failed"
            ? "mislukt"
            : "klaar"
          : `exit ${exitCode}`}{duration !== null
          ? ` · ${seconds(duration)}`
          : ""}
      </span>
    {/if}
    <button
      type="button"
      class="copy"
      onclick={copy}
      aria-label="Uitvoer kopiëren"
    >
      <Icon name="copy" /><span>{copied ? "Gekopieerd" : "Kopiëren"}</span>
    </button>
  </div>
</div>

<style>
  .terminal {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    background: #05060d;
  }
  .screen {
    flex: 1;
    min-height: 0;
    padding: 8px 4px 4px 12px;
  }
  .screen :global(.xterm-viewport) {
    scrollbar-width: thin;
    scrollbar-color: rgb(233 230 245 / 18%) transparent;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px 7px 14px;
    border-top: 1px solid rgb(233 230 245 / 8%);
  }
  .state {
    flex: 1;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--good);
    font: 500 11.5px/1 var(--sans);
    font-variant-numeric: tabular-nums;
  }
  .state.bad {
    color: var(--alert);
  }
  .state.run {
    color: var(--dim);
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--glow);
    animation: beat 1.2s ease-in-out infinite;
  }
  @keyframes beat {
    50% {
      opacity: 0.3;
    }
  }
  .copy {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 10px;
    border: 0;
    border-radius: 7px;
    background: rgb(255 255 255 / 5%);
    color: var(--dim);
    font: 500 11.5px/1 var(--sans);
    cursor: pointer;
    transition:
      color 150ms ease,
      background-color 150ms ease,
      transform 120ms ease-out;
  }
  .copy:active {
    transform: scale(0.97);
  }
  .copy:focus-visible {
    outline: 2px solid var(--glow);
    outline-offset: 1px;
  }
  @media (hover: hover) and (pointer: fine) {
    .copy:hover {
      color: var(--mist);
      background: rgb(255 255 255 / 9%);
    }
  }
  .copy :global(svg) {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
  }
  @media (prefers-reduced-motion: reduce) {
    .dot {
      animation: none;
    }
  }
</style>
