<script lang="ts">
  import { onMount } from "svelte";
  import Button from "#components/ui/Button.svelte";
  import {
    disconnectYoutubeOAuth,
    getYoutubeOAuthStatus,
    saveYoutubeOAuthClient,
    startYoutubeOAuth,
    type YoutubeOAuthStatus,
  } from "#lib/api/settings.ts";

  let status = $state<YoutubeOAuthStatus | null>(null);
  let clientId = $state("");
  let clientSecret = $state("");
  let busy = $state(false);
  let message = $state("");

  onMount(() => {
    const outcome = new URLSearchParams(window.location.search).get(
      "youtubeOAuth",
    );
    if (outcome === "connected") message = "YouTube-account verbonden.";
    if (outcome === "error")
      message =
        "YouTube-koppeling mislukt. Controleer de client en probeer opnieuw.";
    void load();
  });

  async function load() {
    busy = true;
    try {
      status = await getYoutubeOAuthStatus();
    } catch {
      message = "YouTube-koppelingsstatus is niet beschikbaar.";
    } finally {
      busy = false;
    }
  }

  async function save() {
    busy = true;
    message = "";
    try {
      status = await saveYoutubeOAuthClient(clientId.trim(), clientSecret);
      clientId = "";
      clientSecret = "";
      message = "OAuth-client lokaal opgeslagen. Verbind nu je Google-account.";
    } catch {
      message = "OAuth-client kon niet worden opgeslagen.";
    } finally {
      busy = false;
    }
  }

  async function connect() {
    busy = true;
    message = "";
    try {
      const { authorizationUrl } = await startYoutubeOAuth();
      const target = new URL(authorizationUrl);
      if (target.origin !== "https://accounts.google.com")
        throw new Error("Onverwachte autorisatiepagina.");
      window.location.assign(target.href);
    } catch {
      message = "Google-autorisatie kon niet worden gestart.";
      busy = false;
    }
  }

  async function disconnect() {
    if (!window.confirm("Vergeet de YouTube-koppeling op deze NOVA-server?"))
      return;
    busy = true;
    message = "";
    try {
      status = await disconnectYoutubeOAuth();
      message = "YouTube-koppeling lokaal verwijderd.";
    } catch {
      message = "YouTube-koppeling kon niet worden verwijderd.";
    } finally {
      busy = false;
    }
  }
</script>

<section aria-label="YouTube-ondertitels">
  <h3>Ondertitels van je eigen YouTube-video’s</h3>
  <p>
    NOVA kan ondertitels lezen van video’s waarvoor dit Google-account
    bewerkrechten heeft. De officiële API gebruikt 50 quota-eenheden om sporen
    te tonen en 200 om ondertitels te downloaden. NOVA leest alleen; Google
    vereist wel de bredere machtiging <code>youtube.force-ssl</code>.
  </p>
  {#if status?.callbackUrl}
    <p>
      Registreer deze exacte HTTPS-omleidings-URI bij een Google OAuth-client
      van type Webapplicatie: <code>{status.callbackUrl}</code>
    </p>
  {:else}
    <p role="status">
      Stel eerst een publieke HTTPS-URL voor NOVA in via
      <code>NOVA_PUBLIC_URL</code>.
    </p>
  {/if}
  {#if status?.connected}
    <p role="status">
      Google-account verbonden; alleen eigen video’s zijn beschikbaar.
    </p>
    <Button disabled={busy} onclick={disconnect}>Koppeling verwijderen</Button>
  {:else}
    <label>
      OAuth-client-ID
      <input bind:value={clientId} autocomplete="off" spellcheck="false" />
    </label>
    <label>
      OAuth-clientgeheim
      <input
        type="password"
        bind:value={clientSecret}
        autocomplete="new-password"
      />
    </label>
    <Button
      disabled={busy ||
        !clientId.trim() ||
        !clientSecret ||
        !status?.callbackUrl}
      onclick={save}>Client opslaan</Button
    >
    {#if status?.configured}
      <Button disabled={busy || !status.callbackUrl} onclick={connect}
        >Verbinden met Google</Button
      >
    {/if}
  {/if}
  {#if message}<p role="status">{message}</p>{/if}
</section>
