<script lang="ts">
  import { onMount } from "svelte";
  import {
    getHelperPreferences,
    persistHelperPreferences,
  } from "#lib/api/settings.ts";
  import {
    helper,
    normalizeAvatar,
    saveHelperPreferences,
    type Avatar,
  } from "#lib/stores/helper.svelte.ts";

  let selected = $derived(helper.avatar);
  let ready = $state(false);
  let busy = $state(false);
  let message = $state("");
  async function load() {
    try {
      const prefs = await getHelperPreferences();
      helper.avatar = normalizeAvatar(prefs.avatar);
      ready = true;
      message = "";
    } catch {
      message = "Weergave laden mislukt.";
    }
  }
  async function change(event: Event) {
    const value = normalizeAvatar(
      (event.currentTarget as HTMLSelectElement).value,
    );
    const previous: Avatar = helper.avatar;
    // Show it at once: the body re-forms while the choice is saved.
    helper.avatar = value;
    busy = true;
    message = "";
    try {
      const prefs = await getHelperPreferences();
      await persistHelperPreferences({ ...prefs, avatar: value });
      saveHelperPreferences();
      message = "Opgeslagen voor website, wallpaper en helper.";
    } catch {
      helper.avatar = previous;
      selected = previous;
      message = "Opslaan mislukt. Probeer opnieuw.";
    } finally {
      busy = false;
    }
  }
  onMount(() => {
    void load();
  });
</script>

<label class="avatar-choice">
  <span
    >Gedaante
    <small
      >Gestalte: een hoofd en schouders van lichtlijnen die uit de orb groeien.</small
    ></span
  >
  <select
    data-helper-live
    bind:value={selected}
    disabled={!ready || busy}
    onchange={change}
  >
    <option value="orb">Originele orb</option>
    <option value="presence">Gestalte</option>
  </select>
</label>
{#if message}<p class="hint" role="status">{message}</p>{/if}
{#if !ready && message}<button type="button" onclick={load}
    >Opnieuw laden</button
  >{/if}

<style>
  .avatar-choice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s3);
    flex-wrap: wrap;
    padding: var(--s3) 0;
  }
  .avatar-choice span {
    display: grid;
    gap: var(--s1, 4px);
  }
  small {
    opacity: 0.75;
  }
  select {
    font: inherit;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius, 10px);
    padding: var(--s2) var(--s3);
  }
</style>
