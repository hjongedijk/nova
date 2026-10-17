<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError, sendJson } from "#lib/api/client.ts";
  import { appAccess, checkAppAccess } from "#lib/stores/access.svelte.ts";

  let busy = $state(false);
  let token = $state("");
  let error = $state("");
  const english =
    typeof navigator !== "undefined" &&
    navigator.language.toLowerCase().startsWith("en");

  onMount(() => {
    const lock = () => {
      appAccess.required = true;
      appAccess.unlocked = false;
      appAccess.checking = false;
      appAccess.error = "";
    };
    window.addEventListener("nova-app-access-required", lock);
    void checkAppAccess();
    return () => window.removeEventListener("nova-app-access-required", lock);
  });

  async function unlock(event: SubmitEvent) {
    event.preventDefault();
    if (busy || !token) return;
    busy = true;
    error = "";
    try {
      await sendJson("POST", "/access/unlock", { token });
      token = "";
      window.location.reload();
    } catch (cause) {
      const status = cause instanceof ApiError ? cause.status : 0;
      error =
        status === 401
          ? english
            ? "Access token is incorrect."
            : "De toegangscode klopt niet."
          : status === 429
            ? english
              ? "Too many attempts. Try again later."
              : "Te veel pogingen. Probeer het later opnieuw."
            : english
              ? "Secure access is unavailable. Try again shortly."
              : "Beveiligde toegang is niet beschikbaar. Probeer het zo opnieuw.";
    } finally {
      busy = false;
    }
  }
</script>

{#if !appAccess.checking && appAccess.required && !appAccess.unlocked}
  <div class="access-shade">
    <form class="access-card" onsubmit={unlock}>
      <p class="eyebrow">NOVA</p>
      <h1>{english ? "Unlock NOVA" : "NOVA ontgrendelen"}</h1>
      <p>
        {english
          ? "Enter the app access token configured by your administrator."
          : "Voer het app-toegangstoken in dat op de server is ingesteld."}
      </p>
      <label for="app-access-token">
        {english ? "Access token" : "Toegangstoken"}
      </label>
      <input
        id="app-access-token"
        bind:value={token}
        placeholder={english ? "App access token" : "App-toegangscode"}
        aria-invalid={Boolean(error || appAccess.error)}
        aria-describedby={error || appAccess.error
          ? "app-access-error"
          : undefined}
        type="password"
        autocomplete="current-password"
        required
      />
      {#if error || appAccess.error}
        <p class="access-error" role="alert">{error || appAccess.error}</p>
      {/if}
      <button type="submit" disabled={busy || !token}>
        {busy
          ? english
            ? "Checking…"
            : "Controleren…"
          : english
            ? "Unlock"
            : "Ontgrendelen"}
      </button>
    </form>
  </div>
{/if}

<style>
  .access-shade {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgba(4, 8, 17, 0.94);
    backdrop-filter: blur(18px);
  }

  .access-card {
    display: grid;
    gap: 12px;
    width: min(100%, 420px);
    padding: 28px;
    border: 1px solid rgba(107, 227, 244, 0.24);
    background: #0b1320;
    color: #e5f0f5;
  }

  .access-card h1,
  .access-card p {
    margin: 0;
  }

  .access-card .eyebrow {
    color: #59d7e9;
    letter-spacing: 0.22em;
  }

  .access-card label {
    margin-top: 10px;
    font-size: 0.9rem;
  }

  .access-card input {
    min-height: 44px;
    padding: 8px 12px;
    border: 1px solid #355267;
    border-radius: 4px;
    background: #07101b;
    color: inherit;
    font: inherit;
  }

  .access-card button {
    min-height: 44px;
    border: 1px solid #42cfe3;
    border-radius: 4px;
    background: #087b91;
    color: white;
    font: inherit;
    cursor: pointer;
  }

  .access-card button:disabled {
    cursor: wait;
    opacity: 0.55;
  }

  .access-error {
    color: #ff9b91;
  }
  @media (max-height: 240px) {
    .access-shade {
      padding: 2px;
    }
    .access-card {
      padding: 2px;
      gap: 6px;
      width: min(100%, 420px);
    }
    form.access-card {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    form.access-card h1,
    form.access-card p,
    form.access-card label {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      margin: 0;
    }
    .access-card input,
    .access-card button {
      min-width: 0;
      min-height: 34px;
      height: 34px;
      padding: 4px 8px;
      font-size: 12px;
    }
    .access-card input[aria-invalid="true"] {
      border-color: #ff9b91;
    }
  }
</style>
