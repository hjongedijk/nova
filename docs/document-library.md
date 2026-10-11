# Private document library

Upload documents in Settings → Documentbibliotheek. Indexing is an explicit button action; NOVA
does not save ordinary chat attachments automatically. Supported formats are text, PDF and DOCX.
The existing upload checks cap files at 10 MiB each, five files and 20 MiB total. Extraction runs
in a bounded worker and uses at most 24,000 characters per file. Scanned PDFs without text need OCR
outside NOVA before upload; images are not indexed by this library.

NOVA splits extracted text into bounded overlapping chunks. Each chunk is sent to the configured
verified-free remote embedding model through OmniRoute and stored in a dedicated Qdrant collection,
separate from personal semantic memory. Original files are not retained. Search returns at most eight
short excerpts and treats every excerpt as untrusted reference data. The embeddings provider sees
the extracted text, so only upload material appropriate for that configured service.

The document search and list tools are read-only. Removing a document deletes all of its Qdrant
chunks and always requires a fresh confirmation; ask NOVA to list the library and remove the named
document. A model or vector-dimension change may require re-uploading documents: older vectors are
kept but are not mixed into searches using the new model. If the free embedding route is not verified,
indexing and search stay unavailable. The feature never falls back to a local embedding model or a
paid route.
