<script lang="ts">
  // One stroke family (24 grid, 1.5 stroke, round caps) for every window kind and control.
  let { name }: { name: string } = $props();
</script>

<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  {#if name === "browser"}
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path
      d="M3 9h18"
    /><circle cx="6.2" cy="6.8" r=".6" /><circle cx="8.4" cy="6.8" r=".6" />
  {:else if name === "screen"}
    <rect x="3" y="4" width="18" height="12.5" rx="2" /><path
      d="M9 20h6M12 16.5V20"
    />
  {:else if name === "terminal"}
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path
      d="m7 10 3 2.5L7 15M12.5 15H17"
    />
  {:else if name === "video"}
    <rect x="3" y="5" width="18" height="14" rx="2.5" /><path
      d="m10.2 9.2 4.6 2.8-4.6 2.8z"
    />
  {:else if name === "reader"}
    <path d="M5 4.5h10l4 4v11H5z" /><path d="M8.5 11h7M8.5 14h7M8.5 17h4.5" />
  {:else if name === "image"}
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle
      cx="9"
      cy="9.5"
      r="1.6"
    /><path d="m4 17 5-4.5 4 3.5 2.5-2 4.5 3.5" />
  {:else if name === "document"}
    <path d="M6 3.5h8l4 4v13H6z" /><path d="M14 3.5v4h4M9 12.5h6M9 15.5h6" />
  {:else if name === "code"}
    <path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.2 6l-2.4 12" />
  {:else if name === "data"}
    <path d="M4.5 19.5V10M10 19.5V5M15.5 19.5v-7M21 19.5H3" />
  {:else if name === "close"}
    <path d="m7 7 10 10M17 7 7 17" />
  {:else if name === "minimize"}
    <path d="M6.5 12.5h11" />
  {:else if name === "maximize"}
    <rect x="6" y="6" width="12" height="12" rx="2" />
  {:else if name === "restore"}
    <rect x="5.5" y="8.5" width="10" height="10" rx="2" /><path
      d="M9 5.5h7.5a2 2 0 0 1 2 2V15"
    />
  {:else if name === "back"}
    <path d="M14.5 6.5 9 12l5.5 5.5" />
  {:else if name === "forward"}
    <path d="m9.5 6.5 5.5 5.5-5.5 5.5" />
  {:else if name === "reload"}
    <path d="M18.5 12a6.5 6.5 0 1 1-2-4.7M18.5 5v3.5H15" />
  {:else if name === "external"}
    <path
      d="M13.5 5.5h5v5M18.5 5.5l-7.5 7.5M16.5 13.5v4a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 17.5V9A1.5 1.5 0 0 1 7 7.5h4"
    />
  {:else if name === "lock"}
    <rect x="6" y="10.5" width="12" height="9" rx="2" /><path
      d="M9 10.5V8a3 3 0 0 1 6 0v2.5"
    />
  {:else if name === "copy"}
    <rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path
      d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"
    />
  {:else if name === "tile"}
    <rect x="4" y="4" width="7" height="7" rx="1.5" /><rect
      x="13"
      y="4"
      width="7"
      height="7"
      rx="1.5"
    /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect
      x="13"
      y="13"
      width="7"
      height="7"
      rx="1.5"
    />
  {:else if name === "float"}
    <rect x="3.5" y="7" width="11" height="9" rx="1.8" /><rect
      x="9.5"
      y="4"
      width="11"
      height="9"
      rx="1.8"
    />
  {:else if name === "mission"}
    <rect x="3" y="5" width="8" height="6" rx="1.4" /><rect
      x="13"
      y="5"
      width="8"
      height="6"
      rx="1.4"
    /><rect x="3" y="13" width="8" height="6" rx="1.4" /><rect
      x="13"
      y="13"
      width="8"
      height="6"
      rx="1.4"
    />
  {:else if name === "play"}
    <path d="m8.5 6 9 6-9 6z" />
  {:else if name === "pause"}
    <path d="M9 6v12M15 6v12" />
  {:else if name === "pip"}
    <rect x="3" y="5" width="18" height="14" rx="2.5" /><rect
      x="11.5"
      y="11"
      width="7"
      height="5"
      rx="1"
    />
  {:else}
    <circle cx="12" cy="12" r="8.5" /><path
      d="M3.5 12h17M12 3.5c2.4 2.5 3.4 5.3 3.4 8.5s-1 6-3.4 8.5c-2.4-2.5-3.4-5.3-3.4-8.5s1-6 3.4-8.5z"
    />
  {/if}
</svg>
