<script lang="ts">
  import { onMount } from "svelte";
  import Disclosure from "./ui/Disclosure.svelte";
  import type { RuntimeSettingGroup } from "@nova/contracts";
  import {
    getRuntimeSettings,
    saveRuntimeSettings,
  } from "#lib/api/settings.ts";
  import { fail, say } from "./state.svelte.ts";

  let groups = $state<RuntimeSettingGroup[]>([]);
  let drafts = $state<Record<string, Record<string, string | boolean>>>({});
  let reset = $state<Record<string, Record<string, boolean>>>({});
  let busy = $state<string | null>(null);
  let loaded = $state(false);

  function adopt(next: RuntimeSettingGroup[]) {
    groups = next;
    drafts = Object.fromEntries(
      next.map((group) => [
        group.id,
        Object.fromEntries(
          group.fields.map((field) => [
            field.key,
            field.kind === "secret"
              ? ""
              : (field.value ?? (field.kind === "boolean" ? false : "")),
          ]),
        ),
      ]),
    );
    reset = Object.fromEntries(next.map((group) => [group.id, {}]));
  }
  onMount(async () => {
    try {
      adopt((await getRuntimeSettings()).groups);
    } catch (error) {
      fail(error);
    }
    loaded = true;
  });

  async function save(group: RuntimeSettingGroup) {
    busy = group.id;
    try {
      const resetKeys = Object.keys(reset[group.id] ?? {}).filter(
        (key) => reset[group.id]![key],
      );
      const values = Object.fromEntries(
        Object.entries(drafts[group.id] ?? {}).filter(([key, value]) => {
          if (resetKeys.includes(key)) return false;
          const field = group.fields.find((item) => item.key === key);
          // An untouched switch must not turn an .env default into a saved value.
          return field?.kind !== "boolean" || value !== (field.value ?? false);
        }),
      );
      adopt((await saveRuntimeSettings(group.id, values, resetKeys)).groups);
      say(
        `${group.label} opgeslagen.${group.id === "embeddings" ? " Herstart NOVA om de wijziging toe te passen." : ""}`,
        "ok",
      );
    } catch (error) {
      fail(error);
    } finally {
      busy = null;
    }
  }
</script>

<section class="connections-section">
  <p class="hint">
    Opgeslagen waarden vervangen de startwaarden uit .env. Embeddings vereisen
    een herstart; overige wijzigingen gelden direct.
  </p>
  {#if !loaded}<p class="hint">Laden…</p>{/if}
  {#each groups as group (group.id)}
    <Disclosure title={group.label} group="runtime-section">
      {#if group.id === "embeddings"}<p class="hint">
          Herstart NOVA na wijzigen. Een ander model of andere dimensies kan een
          nieuwe geheugenindex vereisen.
        </p>{/if}
      <form
        class="connection-editor"
        onsubmit={(event) => {
          event.preventDefault();
          void save(group);
        }}
      >
        <fieldset disabled={busy !== null}>
          <legend class="connection-legend">{group.label}</legend>
          {#each group.fields as field (field.key)}
            {@const key = `runtime-${group.id}-${field.key}`}
            <div class="connection-field">
              {#if field.kind === "boolean"}
                <label class="connection-check"
                  ><input
                    id={key}
                    type="checkbox"
                    checked={drafts[group.id]?.[field.key] === true}
                    onchange={(event) => {
                      drafts[group.id]![field.key] =
                        event.currentTarget.checked;
                    }}
                  />{field.label}</label
                >
              {:else}
                <label for={key}>{field.label}</label>
                {#if field.kind === "choice"}
                  <select
                    id={key}
                    value={String(drafts[group.id]?.[field.key] ?? "")}
                    onchange={(event) => {
                      drafts[group.id]![field.key] = event.currentTarget.value;
                    }}
                  >
                    <option value="">Standaard</option>
                    {#each field.choices ?? [] as choice (choice)}
                      <option value={choice}>{choice}</option>
                    {/each}
                  </select>
                {:else}
                  <input
                    id={key}
                    type={field.kind === "secret"
                      ? "password"
                      : field.kind === "url"
                        ? "url"
                        : "text"}
                    inputmode={field.kind === "number" ? "decimal" : undefined}
                    autocomplete={field.kind === "secret"
                      ? "new-password"
                      : "off"}
                    maxlength={field.kind === "secret" ? 4096 : 2000}
                    value={String(drafts[group.id]?.[field.key] ?? "")}
                    placeholder={field.kind === "secret"
                      ? field.configured
                        ? "Ingesteld · leeg laten om te bewaren"
                        : "Nog niet ingesteld"
                      : (field.hint ?? "")}
                    oninput={(event) => {
                      drafts[group.id]![field.key] = event.currentTarget.value;
                    }}
                  />
                {/if}
              {/if}
              <small
                >{field.source === "settings"
                  ? "Opgeslagen in NOVA"
                  : field.source === "environment"
                    ? "Startwaarde uit .env"
                    : "Standaardwaarde"}</small
              >
              {#if field.source === "settings"}
                <label class="connection-check"
                  ><input
                    type="checkbox"
                    checked={reset[group.id]?.[field.key] ?? false}
                    onchange={(event) => {
                      reset[group.id]![field.key] = event.currentTarget.checked;
                    }}
                  />Terug naar de startwaarde bij opslaan</label
                >
              {/if}
            </div>
          {/each}
          <div class="set-toolbar"><button type="submit">Opslaan</button></div>
        </fieldset>
      </form>
    </Disclosure>
  {/each}
</section>
