<script lang="ts">
  import { ApiError } from "#lib/api/client.ts";
  import { onMount } from "svelte";
  import {
    getModelMetrics,
    getServiceConnections,
    getServiceConnectionStatus,
  } from "#lib/api/settings.ts";
  import type { ServiceConnectionTest } from "@nova/contracts";

  const storageKey = "nova-installation-checklist-v1";
  const steps = [
    {
      id: "gateway",
      title: "Verbind OmniRoute",
      detail:
        "Controleer het gateway-adres en stel de sleutel in bij de bestaande service-instellingen.",
      href: "/settings?section=modellen",
      link: "Open Modellen",
      required: true,
    },
    {
      id: "policy",
      title: "Koppel een gratis account en verifieer het beleid",
      detail:
        "Gebruik de accountweergave en de beleid-wizard. Een gratis cataloguslabel bewijst geen kosteloze toegang.",
      href: "/settings?section=modellen",
      link: "Open Modellen",
      required: true,
    },
    {
      id: "voice",
      title: "Test stem en microfoon op dit apparaat",
      detail:
        "Speel een voorbeeld af en controleer de microfoon. Browserrechten en aangesloten apparaten verschillen per apparaat.",
      href: "/settings?section=gesprek#stem",
      link: "Open Stem en geluid",
      required: true,
    },
    {
      id: "connections",
      title: "Test de koppelingen die je gebruikt",
      detail:
        "Test elke gewenste service zelf. Niet ingestelde optionele services worden overgeslagen.",
      href: "/settings?section=huis#home-assistant",
      link: "Open Koppelingen",
      required: false,
    },
    {
      id: "review",
      title: "Loop de installatie na",
      detail:
        "Controleer de opgeslagen route, modeltelemetrie en laatste koppelingstests. Modeltelemetrie kan een geauthenticeerde aanvraag naar OmniRoute sturen; er worden geen nieuwe koppelingstests gestart. Test stem en microfoon zelf op dit apparaat.",
      href: null,
      link: null,
      required: true,
    },
  ] as const;
  let done = $state<Record<string, boolean>>({});
  let checkBusy = $state(false);
  let checkError = $state("");
  let finalCheck = $state<{
    routeReady: boolean;
    metricsAvailable: boolean;
    services: { label: string; test: ServiceConnectionTest | null }[];
    checkedAt: string;
  } | null>(null);
  onMount(() => {
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem(storageKey) ?? "{}",
      );
      if (value && typeof value === "object" && !Array.isArray(value)) {
        done = Object.fromEntries(
          steps.map((step) => [
            step.id,
            (value as Record<string, unknown>)[step.id] === true,
          ]),
        );
      }
    } catch {
      done = {};
    }
  });
  function toggle(id: string, checked: boolean) {
    done[id] = checked;
    try {
      localStorage.setItem(storageKey, JSON.stringify(done));
    } catch {
      // The checklist remains usable in memory when browser storage is unavailable.
    }
  }
  const requiredDone = $derived(
    steps.filter((step) => step.required && done[step.id]).length,
  );
  const requiredTotal = steps.filter((step) => step.required).length;
  async function runFinalCheck() {
    checkBusy = true;
    checkError = "";
    try {
      const [metrics, { services }] = await Promise.all([
        getModelMetrics(),
        getServiceConnections(),
      ]);
      const testedServices = await Promise.all(
        services
          .filter(
            (service) => service.id !== "omniroute" && service.id !== "windows",
          )
          .map(async (service) => ({
            label: service.label,
            test: (await getServiceConnectionStatus(service.id)).test,
          })),
      );
      finalCheck = {
        routeReady: metrics.routeReady,
        metricsAvailable: metrics.available,
        services: testedServices,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      finalCheck = null;
      checkError =
        error instanceof ApiError
          ? error.message
          : "Eindcontrole niet beschikbaar.";
    } finally {
      checkBusy = false;
    }
  }
</script>

<section class="installation" aria-label="Installatiewizard">
  <p>
    Doorloop deze stappen bij een nieuwe installatie. Voortgang staat alleen
    lokaal in deze browser; vink een stap zelf af nadat je hem in het
    bijbehorende scherm hebt gecontroleerd.
  </p>
  <p role="status">
    {requiredDone} van {requiredTotal} verplichte stappen door jou afgevinkt. Dit
    is geen automatische gezondheidscontrole.
  </p>
  <ol>
    {#each steps as step, index (step.id)}
      <li>
        <h2>Stap {index + 1}: {step.title}</h2>
        <p>{step.detail}</p>
        {#if step.href && step.link}<a href={step.href}>{step.link}</a>{/if}
        {#if step.id === "review"}
          <button type="button" disabled={checkBusy} onclick={runFinalCheck}>
            {checkBusy ? "Controleren…" : "Eindcontrole uitvoeren"}
          </button>
          {#if checkError}<p role="alert">{checkError}</p>{/if}
          {#if finalCheck}
            <div role="status">
              <p>
                {finalCheck.routeReady
                  ? "De gecontroleerde gratis route is beschikbaar."
                  : "De gratis route is niet als klaar geverifieerd; NOVA kan AI-verkeer blokkeren."}
              </p>
              <small>
                Modeltelemetrie {finalCheck.metricsAvailable
                  ? "is beschikbaar."
                  : "is niet beschikbaar; dit verandert de routestatus niet."}
              </small>
              <h3>Laatste koppelingstests</h3>
              <ul>
                {#each finalCheck.services as item (item.label)}<li>
                    {item.label}: {item.test
                      ? `${item.test.ok ? "geslaagd" : "mislukt"} · ${item.test.checkedAt}`
                      : "niet getest sinds deze start"}
                  </li>{/each}
              </ul>
              <small
                >Gecontroleerd: {finalCheck.checkedAt}. Stem en microfoon zijn
                niet automatisch getest.</small
              >
            </div>
          {/if}
        {/if}
        <label>
          <input
            type="checkbox"
            checked={done[step.id] === true}
            onchange={(event) => toggle(step.id, event.currentTarget.checked)}
          />
          {step.id === "review"
            ? "Ik heb de installatie nagelopen"
            : "Ik heb deze stap gecontroleerd"}
        </label>
      </li>
    {/each}
  </ol>
  <button
    type="button"
    onclick={() => {
      done = {};
      try {
        localStorage.removeItem(storageKey);
      } catch {
        /* Local reset still applies. */
      }
    }}>Voortgang wissen</button
  >
</section>

<style>
  .installation ol {
    padding-left: 1.5rem;
    display: grid;
    gap: 1rem;
  }
  .installation li {
    padding: 1rem;
    border: 1px solid var(--line);
  }
  .installation h2 {
    margin: 0;
    font-size: 1.05rem;
  }
  .installation p {
    line-height: 1.55;
  }
  .installation label {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    margin-top: 0.9rem;
    min-height: 44px;
  }
  .installation input {
    width: 1.1rem;
    height: 1.1rem;
  }
</style>
