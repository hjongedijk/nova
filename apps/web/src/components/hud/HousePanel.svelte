<script lang="ts">
  import { dashboard } from "#lib/stores/dashboard.svelte.ts";
  import { PERSON_STATE, nl } from "#lib/util/format.ts";
  import KvRow from "./KvRow.svelte";

  const house = $derived(dashboard.overview?.home ?? null);

  const rows = $derived.by(() => {
    const out: { label: string; value: string }[] = [];
    for (const person of house?.people ?? [])
      out.push({
        label: person.name,
        value: PERSON_STATE[person.state] || person.state,
      });
    if (house?.lights)
      out.push({
        label: "Lampen",
        value: `${house.lights.on} van ${house.lights.total} aan`,
      });
    if (house?.switches)
      out.push({
        label: "Schakelaars",
        value: `${house.switches.on} van ${house.switches.total} aan`,
      });
    for (const unit of house?.climate ?? [])
      out.push({
        label: unit.name,
        value:
          unit.current != null
            ? `${nl(unit.current)}°${unit.target != null ? ` → ${nl(unit.target, 0)}°` : ""}`
            : "–",
      });
    for (const sensor of house?.temperatures ?? [])
      out.push({
        label: sensor.name,
        value: `${nl(sensor.value)} ${sensor.unit}`,
      });
    if (house?.playing?.length)
      out.push({ label: "Speelt", value: house.playing.join(", ") });
    for (const todo of house?.lists ?? [])
      out.push({ label: todo.name, value: `${todo.open} open` });
    if (house?.updates?.length)
      out.push({
        label: "Updates",
        value: `${house.updates.length} beschikbaar`,
      });
    return out;
  });
</script>

<section class="hud" data-panel="huis" aria-label="Huis">
  <h2>Huis <em></em></h2>
  <ul>
    {#each rows as row, i (i)}
      <KvRow label={row.label} value={row.value} />
    {/each}
  </ul>
  <p class="empty" hidden={rows.length > 0}>
    Home Assistant meldt nog niets over je huis.
  </p>
</section>
