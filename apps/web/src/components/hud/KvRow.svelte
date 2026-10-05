<script lang="ts">
  /** A label with its figure and an optional change in colour (up = glow, down = amber). */
  let {
    label,
    value,
    change = null,
    tone = "up",
  }: {
    label: string;
    value: string;
    change?: string | null;
    tone?: "up" | "down";
  } = $props();
</script>

<li>
  <div class="kv">
    <span>{label}</span>
    <b
      >{value}{#if change}<em class={tone}>{change}</em>{/if}</b
    >
  </div>
</li>
