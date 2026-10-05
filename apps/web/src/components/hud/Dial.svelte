<script lang="ts">
  /** A ring that fills to `fraction` (0..1) with a figure in the middle; `sub` adds a small second line. */
  let {
    fraction,
    text,
    sub,
    variant = "dial",
    label,
    title,
    id,
  }: {
    fraction: number;
    text: string;
    sub?: string;
    variant?: "dial" | "gauge";
    label?: string;
    title?: string;
    id?: string;
  } = $props();

  const offset = $derived(163.4 * (1 - Math.max(0, Math.min(1, fraction))));
</script>

<div class={variant} {id} {title}>
  <svg viewBox="0 0 64 64" aria-hidden="true">
    <circle class="track" cx="32" cy="32" r="26" />
    <circle
      class="arc"
      cx="32"
      cy="32"
      r="26"
      style:stroke-dashoffset={String(offset)}
    />
    {#if sub !== undefined}
      <text class="d" x="32" y="27">{text}</text>
      <text class="sub" x="32" y="42">{sub}</text>
    {:else}
      <text x="32" y="33">{text}</text>
    {/if}
  </svg>
  {#if label}<small>{label}</small>{/if}
</div>
