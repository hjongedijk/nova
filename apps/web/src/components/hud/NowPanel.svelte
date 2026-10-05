<script lang="ts">
  import Dial from "./Dial.svelte";
  import { now } from "./now.svelte.ts";

  const date = $derived(new Date(now.ms));
  const days = $derived(
    new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate(),
  );
</script>

<section class="hud" data-panel="nu" aria-label="Tijd">
  <h2>Nu</h2>
  <div class="dialrow">
    <div>
      <div id="clock">
        {date.toLocaleTimeString("nl-NL", {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </div>
      <div id="date">
        {date.toLocaleDateString("nl-NL", {
          weekday: "long",
          day: "numeric",
          month: "long",
        })}
      </div>
    </div>
    <Dial
      id="dDate"
      fraction={date.getDate() / days}
      text={String(date.getDate())}
      sub={date
        .toLocaleDateString("nl-NL", { month: "short" })
        .replace(".", "")}
    />
  </div>
</section>
