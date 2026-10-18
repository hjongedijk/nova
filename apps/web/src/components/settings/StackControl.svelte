<script lang="ts">
  import { onMount } from "svelte";
  import Button from "#components/ui/Button.svelte";
  import type { StackControlStatus, StackServiceId } from "@nova/contracts";
  import { ApiError } from "#lib/api/client.ts";
  import {
    getStackControlStatus,
    restartStackService,
  } from "#lib/api/settings.ts";
  import { fail, say } from "./state.svelte.ts";

  let status = $state<StackControlStatus | null>(null);
  let busy = $state("");
  let error = $state("");
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  const stateLabel = (state: string) =>
    ({
      running: "actief",
      exited: "gestopt",
      created: "aangemaakt",
      restarting: "herstart bezig",
      paused: "gepauzeerd",
      dead: "defect",
      missing: "ontbreekt",
      unknown: "onbekend",
    })[state] ?? "onbekend";

  async function load() {
    busy = "load";
    error = "";
    try {
      status = await getStackControlStatus();
    } catch (cause) {
      error =
        cause instanceof ApiError
          ? cause.message
          : "Stackstatus niet beschikbaar.";
    } finally {
      busy = "";
    }
  }

  async function restart(service: StackServiceId, label: string) {
    busy = service;
    error = "";
    try {
      const result = await restartStackService(service);
      if (!result.ok) {
        fail(new Error(result.error ?? "Herstart mislukt."));
        return;
      }
      say(
        `${label} herstart aangevraagd. NOVA kan kort niet bereikbaar zijn.`,
        "ok",
      );
      refreshTimer = setTimeout(() => void load(), 10_000);
    } catch (cause) {
      // Restarting NOVA may close this request before its response reaches the browser.
      const outcomeUnknown = !(cause instanceof ApiError);
      if (service === "nova" && outcomeUnknown) {
        say(
          "De verbinding viel weg tijdens de herstartaanvraag. De uitkomst is onbekend; controleer de containerstatus zodra NOVA terug is.",
          "",
        );
        refreshTimer = setTimeout(() => void load(), 10_000);
      } else fail(cause);
    } finally {
      busy = "";
    }
  }

  onMount(() => {
    void load();
    return () => clearTimeout(refreshTimer);
  });
</script>

<section class="mqtt-overview" aria-label="Containerstatus">
  <h3>Containers</h3>
  <p class="hint">
    Alleen-lezen status van de NOVA Compose-stack. Een service herstarten kan
    die service en afhankelijke functies tijdelijk onbereikbaar maken. Een
    herstart gaat direct in.
  </p>
  <Button type="button" onclick={load} disabled={busy !== ""}>
    {busy === "load" ? "Status laden…" : "Containerstatus vernieuwen"}
  </Button>
  {#if error}<p role="alert" class="connection-failed">{error}</p>{/if}
  {#if status?.reason}<p role="status" class="connection-pending">
      {status.reason}
    </p>{/if}
  {#if status?.services.length}
    <ul>
      {#each status.services as service (service.id)}
        <li>
          <strong>{service.label}</strong> — {stateLabel(
            service.state,
          )}{service.health ? `, healthcheck ${service.health}` : ""}
          {#if service.canRestart}<Button
              type="button"
              disabled={!status.available ||
                service.state !== "running" ||
                busy !== ""}
              onclick={() => restart(service.id, service.label)}
              >{busy === service.id
                ? "Bezig…"
                : `${service.label} herstarten`}</Button
            >{:else}<span>Wordt via de Compose-beheerder bijgewerkt.</span>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
