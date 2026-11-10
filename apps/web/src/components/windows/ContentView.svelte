<script lang="ts">
  /* Reader view of a page NOVA read, documents (PDF, markdown, text), code or diffs, and label/value data. */
  import { parseReply } from "#lib/chat/markdown.ts";
  import type { NovaWin } from "#lib/windows/manager.ts";

  let { win }: { win: NovaWin } = $props();
  const text = $derived(typeof win.data.text === "string" ? win.data.text : "");
  const url = $derived(typeof win.data.url === "string" ? win.data.url : "");
  const pdf = $derived(/\.pdf(?:$|[?#])/i.test(url));
  const blocks = $derived(
    win.kind === "reader" || win.kind === "document" ? parseReply(text) : [],
  );
  const lines = $derived(
    win.kind === "code" ? text.split("\n").slice(0, 4000) : [],
  );
  const diff = $derived(win.data.language === "diff");
  const rows = $derived(
    Array.isArray(win.data.rows)
      ? (win.data.rows as { label?: unknown; value?: unknown }[])
          .filter((row) => typeof row?.label === "string")
          .slice(0, 200)
      : [],
  );
</script>

{#if win.kind === "document" && pdf && !text}
  <iframe class="pdf" src={url} title={win.title || "Document"}></iframe>
{:else if win.kind === "code"}
  <pre class="code" class:diff>{#each lines as line, i (i)}<span
        class="ln"
        data-sign={diff ? line.slice(0, 1) : ""}
        ><span class="no">{i + 1}</span>{line}
</span>{/each}</pre>
{:else if win.kind === "data"}
  <dl class="data">
    {#each rows as row, i (i)}
      <dt>{row.label}</dt>
      <dd>{String(row.value ?? "")}</dd>
    {/each}
  </dl>
{:else}
  <article class="reader">
    {#if win.data.domain}<p class="source">{String(win.data.domain)}</p>{/if}
    <h1>{win.title}</h1>
    {#each blocks as block, i (i)}
      {#if block.type === "ul"}
        <ul>
          {#each block.items as item, j (j)}
            <li>
              {#each item as word (word.index)}{word.space ? " " : ""}<span
                  class={word.cls}>{word.text}</span
                >{/each}
            </li>
          {/each}
        </ul>
      {:else if block.heading}
        <h2>
          {#each block.words as word (word.index)}{word.space
              ? " "
              : ""}{word.text}{/each}
        </h2>
      {:else}
        <p>
          {#each block.words as word (word.index)}{word.space ? " " : ""}<span
              class={word.cls}>{word.text}</span
            >{/each}
        </p>
      {/if}
    {/each}
    {#if url}
      <a class="open" href={url} target="_blank" rel="noopener noreferrer"
        >Openen in nieuw tabblad</a
      >
    {/if}
  </article>
{/if}

<style>
  .pdf {
    flex: 1;
    min-height: 0;
    width: 100%;
    border: 0;
    background: #fff;
  }
  .reader {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 18px clamp(18px, 6cqi, 48px) 32px;
    color: var(--mist);
    font: 400 14.5px/1.65 var(--sans);
    scrollbar-width: thin;
    scrollbar-color: rgb(233 230 245 / 18%) transparent;
  }
  .reader > * {
    max-width: 66ch;
  }
  .source {
    margin: 0 0 6px;
    color: var(--glow);
    font-size: 12px;
  }
  h1 {
    margin: 0 0 16px;
    font: 600 21px/1.25 var(--sans);
    letter-spacing: -0.015em;
    text-wrap: balance;
  }
  h2 {
    margin: 22px 0 6px;
    font: 600 15.5px/1.3 var(--sans);
  }
  p,
  ul {
    margin: 0 0 12px;
  }
  .b {
    font-weight: 600;
  }
  .c {
    font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
    font-size: 0.92em;
  }
  .open {
    display: inline-block;
    margin-top: 8px;
    color: var(--glow);
  }
  .reader ::selection,
  .code ::selection {
    background: color-mix(in srgb, var(--glow) 30%, transparent);
  }
  .code {
    flex: 1;
    min-height: 0;
    margin: 0;
    overflow: auto;
    padding: 10px 0;
    background: #05060d;
    color: var(--mist);
    font:
      400 12.5px/1.5 ui-monospace,
      "Cascadia Mono",
      Consolas,
      monospace;
    tab-size: 2;
  }
  .ln {
    display: block;
    padding-right: 16px;
    white-space: pre;
  }
  .no {
    display: inline-block;
    width: 44px;
    padding-right: 12px;
    color: #5d5a7a;
    text-align: right;
    user-select: none;
    font-variant-numeric: tabular-nums;
  }
  .diff .ln[data-sign="+"] {
    background: color-mix(in srgb, var(--good) 12%, transparent);
    color: var(--good);
  }
  .diff .ln[data-sign="-"] {
    background: color-mix(in srgb, var(--alert) 12%, transparent);
    color: #ffb4a3;
  }
  .diff .ln[data-sign="@"] {
    color: var(--glow);
  }
  .data {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    margin: 0;
    padding: 8px 16px 16px;
    font: 400 13px/1.4 var(--sans);
  }
  .data dt,
  .data dd {
    margin: 0;
    padding: 8px 0;
    border-bottom: 1px solid rgb(233 230 245 / 8%);
  }
  .data dt {
    color: var(--dim);
  }
  .data dd {
    color: var(--mist);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
</style>
