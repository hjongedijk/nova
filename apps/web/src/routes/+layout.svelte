<script lang="ts">
  import "../app.css";
  import "../components/shell/shell.css";
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
</script>

{@render children()}
