<script lang="ts">
  import { dismissToast, toasts } from "#lib/stores/toasts.svelte.ts";
</script>

<div id="toasts" role="region" aria-label="Meldingen" aria-live="polite">
  {#each toasts.items as toast (toast.id)}
    <div
      class="toast {toast.severity}"
      role={toast.severity === "info" ? "status" : "alert"}
    >
      <strong>{toast.title}</strong>
      {#if toast.detail}<span>{toast.detail}</span>{/if}
      <button
        type="button"
        aria-label="Melding sluiten"
        onclick={() => dismissToast(toast.id)}>×</button
      >
    </div>
  {/each}
</div>
