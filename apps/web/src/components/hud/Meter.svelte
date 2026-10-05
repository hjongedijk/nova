<script lang="ts">
  /** The segmented bar under VMs and storage: `.bar` with a filled `u`. */
  let { percent, id }: { percent: number; id?: string } = $props();
</script>

<s class="bar" {id}><u style:width="{Math.round(percent)}%"></u></s>
