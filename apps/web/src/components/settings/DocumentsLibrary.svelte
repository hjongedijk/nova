<script lang="ts">
  import { ApiError } from "#lib/api/client.ts";
  import { onMount } from "svelte";
  import { encodeAttachments } from "#lib/chat/attachments.ts";
  import {
    indexDocuments,
    listDocuments,
    searchDocuments,
    type DocumentSearchHit,
    type IndexedDocument,
  } from "#lib/api/documents.ts";

  let files: File[] = $state([]);
  let documents: IndexedDocument[] = $state([]);
  let results: DocumentSearchHit[] = $state([]);
  let query = $state("");
  let configured = $state(false);
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");

  async function reload() {
    try {
      const response = await listDocuments();
      configured = response.configured;
      documents = response.documents;
    } catch (reason) {
      error =
        reason instanceof ApiError
          ? reason.message
          : "Bibliotheek laden mislukt.";
    }
  }

  onMount(() => void reload());

  async function indexSelected() {
    if (!files.length || busy) return;
    busy = true;
    error = "";
    notice = "";
    try {
      const uploaded = await indexDocuments(await encodeAttachments(files));
      files = [];
      notice = `${uploaded.documents.length} document${uploaded.documents.length === 1 ? "" : "en"} veilig geïndexeerd.${uploaded.truncated ? " Van een groot document is alleen het eerste deel gebruikt." : ""}`;
      await reload();
    } catch (reason) {
      error =
        reason instanceof ApiError ? reason.message : "Indexeren mislukt.";
    } finally {
      busy = false;
    }
  }

  async function search() {
    if (busy || query.trim().length < 2) return;
    busy = true;
    error = "";
    try {
      results = (await searchDocuments(query.trim())).results;
    } catch (reason) {
      error = reason instanceof ApiError ? reason.message : "Zoeken mislukt.";
    } finally {
      busy = false;
    }
  }
</script>

<section class="documents" aria-labelledby="documentHeading">
  <h2 id="documentHeading">Privé documentbibliotheek</h2>
  <p>
    Upload PDF-, DOCX- of tekstbestanden om er later vragen over te stellen.
    NOVA stuurt de uitgelezen tekstfragmenten naar de ingestelde,
    geverifieerd-gratis embeddingroute en bewaart die in een aparte
    Qdrant-collectie. Het originele bestand wordt niet bewaard.
  </p>

  {#if !configured}
    <p class="state">
      Stel eerst een geverifieerd gratis embeddingmodel en Qdrant in bij
      Modellen en Koppelingen.
    </p>
  {:else}
    <label for="documentFiles">Documenten kiezen</label>
    <input
      id="documentFiles"
      type="file"
      accept=".pdf,.docx,.txt,.md,.csv,.json"
      multiple
      onchange={(event) => {
        files = Array.from(event.currentTarget.files ?? []).slice(0, 5);
      }}
    />
    {#if files.length}<p>{files.map((file) => file.name).join(", ")}</p>{/if}
    <button
      type="button"
      disabled={!files.length || busy}
      onclick={indexSelected}
      >{busy ? "Bezig…" : "Aan bibliotheek toevoegen"}</button
    >

    <h3>Doorzoek documenten</h3>
    <form
      onsubmit={(event) => {
        event.preventDefault();
        void search();
      }}
    >
      <label for="documentQuery">Waar zoek je naar?</label>
      <input
        id="documentQuery"
        bind:value={query}
        maxlength="500"
        placeholder="Bijvoorbeeld: garantie op de warmtepomp"
      />
      <button type="submit" disabled={busy || query.trim().length < 2}
        >Zoeken</button
      >
    </form>
    {#if results.length}
      <ul class="results">
        {#each results as result (`${result.documentId}-${result.chunk}`)}
          <li>
            <strong>{result.name}</strong>
            <p>{result.text}</p>
          </li>
        {/each}
      </ul>
    {:else if query && !busy}<p class="state">Geen passende fragmenten.</p>{/if}

    <h3>Opgeslagen documenten ({documents.length})</h3>
    {#if documents.length}
      <ul>
        {#each documents as document (document.id)}<li>
            {document.name} <span>{document.chunks} fragmenten</span>
          </li>{/each}
      </ul>
      <p>
        Vraag NOVA in de chat om één van deze documenten te doorzoeken. Om een
        document te verwijderen, vraag NOVA dat expliciet; verwijderen vraagt
        altijd om een nieuwe bevestiging.
      </p>
    {:else}<p class="state">Nog geen documenten toegevoegd.</p>{/if}
  {/if}

  {#if notice}<p role="status">{notice}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
  .documents {
    display: grid;
    gap: 0.75rem;
    max-width: 52rem;
  }
  .documents p {
    line-height: 1.55;
  }
  .documents input:not([type="file"]) {
    width: 100%;
  }
  .documents form {
    display: grid;
    gap: 0.5rem;
  }
  .documents button {
    justify-self: start;
  }
  .documents ul {
    display: grid;
    gap: 0.75rem;
    padding-left: 1.2rem;
  }
  .documents li p {
    margin-bottom: 0;
  }
  .documents li span {
    opacity: 0.7;
  }
  .state {
    opacity: 0.75;
  }
  .error {
    color: var(--danger, #f66);
  }
</style>
