<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import { dashboard, runAction } from "#lib/stores/dashboard.svelte.ts";
  import { mmss } from "#lib/util/format.ts";
  import { now } from "./now.svelte.ts";

  const open = new SvelteSet<string>();
  let drafts = $state<Record<string, string>>({});

  // Each timer counts down from the moment its overview arrived.
  const timers = $derived(
    (dashboard.overview?.timers ?? []).map((timer) => ({
      ...timer,
      end: Date.now() + timer.remainingSeconds * 1000,
    })),
  );
  const lists = $derived(Object.entries(dashboard.overview?.lists ?? {}));
  const total = $derived(timers.length + lists.length);

  function toggle(name: string) {
    if (!open.delete(name)) open.add(name);
  }

  function add(name: string) {
    const item = (drafts[name] ?? "").trim();
    if (!item) return;
    drafts[name] = "";
    void runAction("list_add", { list: name, item }, `Toegevoegd aan ${name}.`);
  }
</script>

<section class="hud" data-panel="planning" aria-label="Planning">
  <h2>
    Planning
    <em>{total ? `${timers.length} timers · ${lists.length} lijsten` : ""}</em>
  </h2>
  <ul id="timerList">
    {#each timers as timer, i (timer.id ?? i)}
      <li class="ok timer-row">
        <i></i>
        <span>{timer.label}</span>
        <time>{mmss((timer.end - now.ms) / 1000)}</time>
        {#if timer.id}
          <button
            type="button"
            class="row-x"
            title="Timer “{timer.label}” stoppen"
            aria-label="Timer “{timer.label}” stoppen"
            onclick={() =>
              runAction("timer_cancel", { id: timer.id }, "Timer gestopt.")}
            >×</button
          >
        {/if}
      </li>
    {/each}
  </ul>
  <ul id="listList">
    {#each lists as [name, items] (name)}
      <li>
        <button
          type="button"
          class="row-btn"
          title={items.join(", ")}
          onclick={() => toggle(name)}
        >
          <i
            style="width:6px;height:6px;border-radius:50%;background:var(--dim);flex:none"
          ></i>
          <span class="grow">{name}</span>
          <b>{items.length}</b>
        </button>
        {#if open.has(name)}
          <ul class="list-items">
            {#each items as text, k (k)}
              <li>
                <span>{text}</span>
                <button
                  type="button"
                  class="row-x"
                  title="“{text}” van de lijst halen"
                  aria-label="“{text}” van de lijst halen"
                  onclick={() =>
                    runAction(
                      "list_remove",
                      { list: name, item: text },
                      `Van ${name} gehaald.`,
                    )}>×</button
                >
              </li>
            {/each}
          </ul>
          <form
            class="list-add"
            onsubmit={(event) => {
              event.preventDefault();
              add(name);
            }}
          >
            <input
              type="text"
              maxlength="200"
              placeholder="Toevoegen…"
              aria-label="Iets toevoegen aan {name}"
              value={drafts[name] ?? ""}
              oninput={(event) => (drafts[name] = event.currentTarget.value)}
            />
          </form>
        {/if}
      </li>
    {/each}
  </ul>
  <p class="empty" hidden={total > 0}>
    Geen timers of lijsten. Zeg: zet een timer van tien minuten.
  </p>
</section>
