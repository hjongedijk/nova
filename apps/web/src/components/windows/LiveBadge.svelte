<script lang="ts">
  let {
    state,
    reason = "",
  }: {
    state: "connecting" | "live" | "snapshot" | "offline";
    reason?: string;
  } = $props();
  const label = $derived(
    state === "live"
      ? "Live"
      : state === "snapshot"
        ? "Momentopname"
        : state === "offline"
          ? "Geen beeld"
          : "Verbinden",
  );
</script>

<span class="badge" data-state={state} title={reason || label}>
  <span class="dot" aria-hidden="true"></span>{label}
</span>

<style>
  .badge {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 22px;
    padding: 0 9px;
    border-radius: 11px;
    background: rgb(255 255 255 / 5%);
    color: var(--dim);
    font: 500 10.5px/1 var(--sans);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--dim);
  }
  .badge[data-state="live"] {
    color: #ffd7cf;
    background: color-mix(in srgb, var(--alert) 18%, transparent);
  }
  .badge[data-state="live"] .dot {
    background: var(--alert);
    animation: beat 1.6s ease-in-out infinite;
  }
  .badge[data-state="snapshot"] {
    color: var(--amber);
  }
  .badge[data-state="snapshot"] .dot {
    background: var(--amber);
  }
  @keyframes beat {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .badge[data-state="live"] .dot {
      animation: none;
    }
  }
</style>
