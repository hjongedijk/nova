<script lang="ts">
  import { onMount } from "svelte";
  import {
    getHelperPreferences,
    persistHelperPreferences,
  } from "#lib/api/settings.ts";
  import { helper, saveHelperPreferences } from "#lib/stores/helper.svelte.ts";

  let selected = $derived(helper.avatar);
  let ready = $state(false);
  let busy = $state(false);
  let message = $state("");
  async function load() {
    try {
      const prefs = await getHelperPreferences();
      helper.avatar = prefs.avatar ?? "face";
      ready = true;
      message = "";
    } catch {
      message = "Avatarinstelling laden mislukt.";
    }
  }
  async function change(event: Event) {
    const value = (event.currentTarget as HTMLSelectElement).value as
      "face" | "orb";
    const previous = helper.avatar;
    busy = true;
    message = "";
    try {
      const prefs = await getHelperPreferences();
      await persistHelperPreferences({ ...prefs, avatar: value });
      helper.avatar = value;
      saveHelperPreferences();
      message = "Opgeslagen voor alle schermen.";
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
  <span>Avatar voor website, wallpaper en helper</span>
  <select
    data-helper-live
    bind:value={selected}
    disabled={!ready || busy}
    onchange={change}
  >
    <option value="face">Gezicht</option>
    <option value="orb">Originele orb</option>
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
  select {
    font: inherit;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius, 10px);
    padding: var(--s2) var(--s3);
  }
</style>
