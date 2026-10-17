<script lang="ts">
  import { onMount } from "svelte";
  import { getConversation } from "#lib/api/conversation.ts";
  import { getTelephony } from "#lib/api/telephony.ts";
  import { getModelMetrics, getServiceConnections } from "#lib/api/settings.ts";
  import StatusPill from "./ui/StatusPill.svelte";

  type State = "ok" | "todo" | "unknown";
  interface Step {
    id: string;
    title: string;
    ok: string;
    todo: string;
    href: string;
    action: string;
    state: State;
  }
  const KEY = "nova.settings.getting-started.hidden";
  let hidden = $state(false);
  let loaded = $state(false);
  let steps = $state<Step[]>([
    {
      id: "voice",
      title: "Stem",
      ok: "NOVA kan je horen en praten.",
      todo: "NOVA kan je nog niet horen. Controleer je stem en microfoon.",
      href: "/settings?section=gesprek#stem",
      action: "Stem instellen",
      state: "unknown",
    },
    {
      id: "model",
      title: "Slimme modellen",
      ok: "NOVA kan antwoorden geven.",
      todo: "NOVA kan nog niet antwoorden. Verbind een gratis dienst.",
      href: "/settings?section=modellen",
      action: "Dienst verbinden",
      state: "unknown",
    },
    {
      id: "home",
      title: "Slimme huis",
      ok: "Je huis is gekoppeld.",
      todo: "Je huis is nog niet gekoppeld. Dit is niet verplicht.",
      href: "/settings?section=huis#home-assistant",
      action: "Huis koppelen",
      state: "unknown",
    },
    {
      id: "phone",
      title: "Telefoon",
      ok: "Bellen via NOVA werkt.",
      todo: "Bellen via NOVA staat uit. Dit is niet verplicht.",
      href: "/settings?section=telefoon",
      action: "Telefoon instellen",
      state: "unknown",
    },
  ]);

  const done = $derived(steps.filter((s) => s.state === "ok").length);
  const everythingDone = $derived(loaded && done === steps.length);

  function set(id: string, ok: boolean | null) {
    const step = steps.find((s) => s.id === id);
    if (step) step.state = ok === null ? "unknown" : ok ? "ok" : "todo";
  }

  onMount(() => {
    try {
      hidden = localStorage.getItem(KEY) === "1";
    } catch {
      /* private mode: show it */
    }
    void Promise.allSettled([
      getConversation().then(({ status }) => {
        const mic =
          typeof navigator !== "undefined" && !!navigator.mediaDevices;
        set("voice", mic && status.speechToText.ready);
      }),
      getModelMetrics().then((m) => set("model", m.available && m.routeReady)),
      getServiceConnections().then(({ services }) => {
        const ha = services.find((s) => s.id === "home-assistant");
        set(
          "home",
          !!ha &&
            ha.fields.every((f) =>
              f.kind === "secret" ? f.set : !!f.value || f.kind === "boolean",
            ),
        );
      }),
      getTelephony().then((t) => set("phone", t.enabled && t.connected)),
    ])
      .then((results) => {
        results.forEach((result, index) => {
          if (result.status === "rejected")
            set(["voice", "model", "home", "phone"][index] ?? "", null);
        });
      })
      .finally(() => (loaded = true));
  });

  function hide() {
    hidden = true;
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* the choice only lasts for this visit */
    }
  }
</script>

{#if loaded && !hidden && !everythingDone}
  <section class="start" id="aan-de-slag" aria-label="Aan de slag">
    <header>
      <h2>Aan de slag</h2>
      <StatusPill
        tone={done === steps.length ? "ok" : "warn"}
        label="{done} van {steps.length} klaar"
      />
    </header>
    <p class="ds-lead">
      Vier korte controles. Wat al werkt hoef je niet meer te doen.
    </p>
    <ul>
      {#each steps as step (step.id)}
        <li data-state={step.state}>
          <span class="mark" aria-hidden="true"
            >{step.state === "ok"
              ? "✓"
              : step.state === "todo"
                ? "!"
                : "•"}</span
          >
          <span class="what"
            ><strong>{step.title}</strong>
            <span
              >{step.state === "ok"
                ? step.ok
                : step.state === "todo"
                  ? step.todo
                  : "Even controleren…"}</span
            ></span
          >
          {#if step.state !== "ok"}<a class="btn" href={step.href}
              >{step.action}</a
            >{/if}
        </li>
      {/each}
    </ul>
    <button type="button" class="later" onclick={hide}>Verberg dit</button>
  </section>
{/if}

<style>
  .start {
    margin: 0 0 var(--s5);
    padding: var(--s5);
    background: var(--surface);
    border: 1px solid var(--glow);
    border-radius: var(--radius);
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s2) var(--s3);
  }
  header :global(h2) {
    margin: 0;
    font-size: 20px;
  }
  ul {
    list-style: none;
    margin: 0 0 var(--s3);
    padding: 0;
  }
  li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s2) var(--s3);
    padding: var(--s3) 0;
    border-top: 1px solid var(--line);
  }
  .mark {
    display: inline-grid;
    place-items: center;
    flex: none;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    font-weight: 700;
    background: var(--line);
    color: var(--mist);
  }
  li[data-state="ok"] .mark {
    background: var(--good);
    color: var(--ink);
  }
  li[data-state="todo"] .mark {
    background: var(--amber);
    color: var(--ink);
  }
  .what {
    flex: 1 1 220px;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .what span {
    color: var(--dim);
  }
  a.btn {
    display: inline-flex;
    align-items: center;
    text-decoration: none;
  }
</style>
