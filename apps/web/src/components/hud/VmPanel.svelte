<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import { ask } from "#lib/stores/chat.svelte.ts";
  import { showChrome } from "#lib/stores/chrome.svelte.ts";
  import { dashboard, guests } from "#lib/stores/dashboard.svelte.ts";
  import { gb } from "#lib/util/format.ts";
  import Meter from "./Meter.svelte";

  const open = new SvelteSet<number>();
  const list = $derived(guests());

  function choices(vm: { vmid: number; name: string; status: string }) {
    const running = vm.status === "running";
    return [
      ["Status", `Geef de status van ${vm.name} (VM ${vm.vmid}).`],
      ...(running
        ? [
            ["Afsluiten", `Sluit ${vm.name} (VM ${vm.vmid}) netjes af.`],
            ["Herstarten", `Herstart ${vm.name} (VM ${vm.vmid}).`],
          ]
        : [["Starten", `Start ${vm.name} (VM ${vm.vmid}).`]]),
    ] as [string, string][];
  }

  function toggle(vmid: number) {
    if (!open.delete(vmid)) open.add(vmid);
  }
</script>

<section class="hud" data-panel="vms" aria-label="Virtuele machines">
  <h2>
    Virtuele machines
    <em
      >{list.length
        ? `${list.filter((g) => g.status === "running").length}/${list.length} actief`
        : "–"}</em
    >
  </h2>
  <ul>
    {#each list.slice(0, 6) as vm (vm.vmid)}
      {@const running = vm.status === "running"}
      <li>
        <button
          type="button"
          class="vm"
          class:up={running}
          title="VM {vm.vmid} · {running
            ? `geheugen ${gb(vm.memoryUsed)} van ${gb(vm.memoryTotal)} GB`
            : vm.status}"
          onmouseenter={() => (dashboard.hotVmid = vm.vmid)}
          onfocus={() => (dashboard.hotVmid = vm.vmid)}
          onmouseleave={() => (dashboard.hotVmid = null)}
          onblur={() => (dashboard.hotVmid = null)}
          onclick={() => toggle(vm.vmid)}
        >
          <i></i>
          <span class="n">{vm.name}</span>
          <b>{running && vm.cpu !== null ? `${Math.round(vm.cpu)}%` : "uit"}</b>
          <Meter percent={running ? vm.cpu || 0 : 0} />
        </button>
        {#if open.has(vm.vmid)}
          <div class="wbuttons vm-actions">
            {#each choices(vm) as [label, sentence] (label)}
              <button
                type="button"
                class="wbtn"
                onclick={() => {
                  showChrome();
                  void ask(sentence);
                }}>{label}</button
              >
            {/each}
          </div>
        {/if}
      </li>
    {/each}
    {#if list.length > 6}<li>+{list.length - 6} meer</li>{/if}
  </ul>
  <p class="empty">{list.length ? "" : "Proxmox is niet bereikbaar."}</p>
</section>
