<script lang="ts">
  import { ask } from "#lib/stores/chat.svelte.ts";
  import { dashboard } from "#lib/stores/dashboard.svelte.ts";

  const items = $derived((dashboard.overview?.news ?? []).slice(0, 5));
</script>

<section class="hud" data-panel="nieuws" aria-label="Nieuws">
  <h2>Nieuws <em>NOS</em></h2>
  <ul>
    {#each items as news (news.link)}
      <li>
        <button
          type="button"
          class="news-btn"
          title="Laat NOVA hier meer over vertellen"
          onclick={() =>
            ask(
              `Vertel me meer over dit nieuwsbericht van de NOS: ${news.title} (${news.link})`,
            )}>{news.title}</button
        >
      </li>
    {/each}
  </ul>
  <p class="empty" hidden={items.length > 0}>Geen nieuws beschikbaar.</p>
</section>
