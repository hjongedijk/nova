<script lang="ts">
  import { ApiError } from "#lib/api/client.ts";
  import {
    getWorkspaceCodeFile,
    getWorkspaceCodeRun,
    getWorkspaceCodeTree,
  } from "#lib/api/settings.ts";
  import { shell } from "#lib/stores/shell.svelte.ts";

  type Tree = Awaited<ReturnType<typeof getWorkspaceCodeTree>>;
  let tree = $state<Tree | null>(null);
  let file = $state<Awaited<ReturnType<typeof getWorkspaceCodeFile>> | null>(
    null,
  );
  let run = $state<Awaited<ReturnType<typeof getWorkspaceCodeRun>> | null>(
    null,
  );
  let error = $state("");
  let busy = $state(false);

  async function refresh() {
    busy = true;
    error = "";
    try {
      const [nextTree, latest] = await Promise.all([
        getWorkspaceCodeTree(),
        getWorkspaceCodeRun(),
      ]);
      tree = nextTree;
      run = latest;
      if (
        file &&
        !tree.files.some(
          (item) => `${tree?.projectId}/${item.path}` === file?.path,
        )
      )
        file = null;
    } catch (cause) {
      error =
        cause instanceof ApiError
          ? cause.message
          : "Codeproject niet beschikbaar.";
    } finally {
      busy = false;
    }
  }

  async function openFile(path: string) {
    busy = true;
    error = "";
    try {
      file = await getWorkspaceCodeFile(path);
    } catch (cause) {
      error =
        cause instanceof ApiError ? cause.message : "Bestand niet beschikbaar.";
    } finally {
      busy = false;
    }
  }

  let wasOpen = false;
  $effect(() => {
    const open = shell.codeOpen;
    if (open && !wasOpen) void refresh();
    wasOpen = open;
    document.body.classList.toggle("code-open", open);
  });
</script>

{#if shell.codeOpen}
  <aside class="code-panel" aria-label="Codeproject">
    <header>
      <div>
        <strong>Werkruimte</strong>{#if tree}<span>{tree.projectId}</span>{/if}
      </div>
      <div class="actions">
        <button type="button" onclick={() => void refresh()} disabled={busy}
          >Vernieuwen</button
        >
        <button
          type="button"
          aria-label="Codeweergave sluiten"
          onclick={() => (shell.codeOpen = false)}>×</button
        >
      </div>
    </header>
    {#if error}<p class="error" role="status">{error}</p>{/if}
    {#if tree}
      <div class="code-grid">
        <nav aria-label="Projectbestanden">
          {#each tree.files as item (item.path)}
            <button
              type="button"
              class:active={file?.path === item.path}
              onclick={() => void openFile(item.path)}
              disabled={busy}
            >
              <span>{item.path}</span><small
                >{item.bytes.toLocaleString("nl-NL")} B</small
              >
            </button>
          {:else}<p class="empty">Nog geen bestanden.</p>{/each}
          {#if tree.truncated}<p class="empty">Bestandslijst begrensd.</p>{/if}
        </nav>
        <section class="file-view" aria-label="Bestandsinhoud">
          {#if file}
            <div class="file-title">
              <strong>{file.path}</strong><small
                >Alleen-lezen · SHA-256 {file.sha256.slice(0, 12)}</small
              >
            </div>
            <pre>{file.content}</pre>
          {:else}<p class="empty">Kies een bestand om te bekijken.</p>{/if}
        </section>
      </div>
      <section class="terminal" aria-label="Laatste testuitvoer">
        <div class="file-title">
          <strong>Laatste sandbox-run</strong>{#if run}<small
              >{run.command.join(" ")} · {run.durationMs} ms · {run.exitCode ===
              0
                ? "geslaagd"
                : `code ${run.exitCode ?? "onbekend"}`}</small
            >{/if}
        </div>
        <textarea
          readonly
          value={run?.output ?? "Nog geen tests uitgevoerd."}
          aria-label="Alleen-lezen testuitvoer"></textarea>
      </section>
      <p class="footnote">
        Bestanden en uitvoer zijn alleen-lezen. Vraag NOVA in de chat om een
        wijziging; de diff verschijnt bij de bevestiging.
      </p>
    {:else if !busy}<p class="empty">
        Maak of open eerst een project via Instellingen → Code.
      </p>{/if}
  </aside>
{/if}

<style>
  .code-panel {
    position: fixed;
    z-index: 32;
    inset: 4.5rem 1rem 1rem auto;
    width: min(760px, calc(100vw - 2rem));
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1rem;
    border: 1px solid var(--line, rgba(255, 255, 255, 0.16));
    border-radius: 1rem;
    background: rgba(13, 19, 28, 0.97);
    box-shadow: 0 24px 80px #0009;
    color: var(--text, #edf2f7);
    backdrop-filter: blur(24px);
  }
  header,
  .actions,
  .file-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  header strong {
    font-size: 1rem;
  }
  header span,
  .file-title small {
    display: block;
    color: var(--mist, #aab5c4);
    font-size: 0.75rem;
    margin-top: 0.15rem;
  }
  .actions button,
  .code-grid nav button {
    border: 1px solid var(--line, rgba(255, 255, 255, 0.16));
    border-radius: 0.5rem;
    background: #ffffff0a;
    color: inherit;
    padding: 0.5rem 0.65rem;
    cursor: pointer;
  }
  .code-grid {
    min-height: 0;
    flex: 1;
    display: grid;
    grid-template-columns: minmax(150px, 0.35fr) minmax(0, 1fr);
    gap: 0.75rem;
  }
  .code-grid nav,
  .file-view,
  .terminal {
    min-height: 0;
    overflow: auto;
    border: 1px solid var(--line, rgba(255, 255, 255, 0.1));
    border-radius: 0.65rem;
    background: #05090f66;
  }
  .code-grid nav {
    padding: 0.4rem;
  }
  .code-grid nav button {
    width: 100%;
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    text-align: left;
    margin-bottom: 0.25rem;
    font: inherit;
    font-size: 0.8rem;
  }
  .code-grid nav button.active {
    background: #86c9ff22;
    border-color: #86c9ff88;
  }
  .code-grid nav small {
    color: var(--mist, #aab5c4);
    white-space: nowrap;
  }
  .file-view {
    display: flex;
    flex-direction: column;
  }
  .file-title {
    padding: 0.55rem 0.7rem;
    border-bottom: 1px solid var(--line, rgba(255, 255, 255, 0.1));
    font-size: 0.8rem;
  }
  .file-view pre {
    margin: 0;
    padding: 0.75rem;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font:
      0.78rem/1.55 ui-monospace,
      monospace;
    color: #d8e6f3;
  }
  .terminal {
    flex: none;
    height: 30%;
    display: flex;
    flex-direction: column;
  }
  .terminal textarea {
    flex: 1;
    resize: none;
    min-height: 4rem;
    border: 0;
    padding: 0.65rem;
    background: transparent;
    color: #c9d7e6;
    font:
      0.75rem/1.5 ui-monospace,
      monospace;
  }
  .empty,
  .footnote,
  .error {
    padding: 0.5rem 0.75rem;
    color: var(--mist, #aab5c4);
    font-size: 0.8rem;
  }
  .error {
    color: #ff9eaa;
  }
  .footnote {
    margin: 0;
    padding: 0;
    font-size: 0.72rem;
  }
  @media (max-width: 700px) {
    .code-panel {
      inset: 3.8rem 0.5rem 0.5rem;
      width: auto;
      padding: 0.65rem;
    }
    .code-grid {
      grid-template-columns: minmax(105px, 0.4fr) minmax(0, 1fr);
      gap: 0.4rem;
    }
    .file-title {
      align-items: flex-start;
      flex-direction: column;
      gap: 0.2rem;
    }
    .code-grid nav button {
      font-size: 0.7rem;
      flex-direction: column;
    }
    .code-grid nav small {
      font-size: 0.65rem;
    }
  }
</style>
