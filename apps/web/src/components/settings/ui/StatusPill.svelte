<script lang="ts">
  /** A status in words and a shape, never in colour alone. */
  let {
    tone = "neutral",
    label,
  }: { tone?: "ok" | "warn" | "bad" | "neutral"; label: string } = $props();
  const icon = { ok: "✓", warn: "!", bad: "✕", neutral: "•" };
</script>

<span class="ds-pill ds-pill-{tone}" data-tone={tone}
  ><span class="ds-pill-icon" aria-hidden="true">{icon[tone]}</span
  >{label}</span
>
