// ─────────────────────────────────────────────
// Document CRUD handlers (thin db wrappers)
// ─────────────────────────────────────────────
// Extracted from service-worker.ts. Depend only on lib/db + vector-store
// index resets — no shared worker state. Read path guarded by
// e2e/capture.spec.ts.

import {
  listDocuments, getDocument, deleteDocument, getDocumentCount,
  updateDocumentSelection, linkDocumentToProject, unlinkDocumentFromProject
} from '../lib/db';
import { resetLibraryIndex } from '../lib/vector-store';

export async function handleLinkDocument(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  await linkDocumentToProject(request.projectId as string, request.docId as string);
  return { success: true };
}

export async function handleUnlinkDocument(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  await unlinkDocumentFromProject(request.projectId as string, request.docId as string);
  return { success: true };
}

export async function handleListDocuments(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const projectId = request.projectId as string | undefined;
  const documents = await listDocuments(projectId);
  // The GLOBAL list (no projectId) is a getAll() over EVERY document the user has
  // ever captured — unbounded. Shipping each doc's full markdown ratcheted the
  // sidepanel heap into the GBs on panel open (measured: 328 MB → 2 GB). The panel
  // only uses the global list to locate a doc by id (then opens it via
  // GET_DOCUMENT, which returns the full body). So strip content here — but keep
  // just the frontmatter so contentHasTag()/isResearchSource still classify docs.
  // The per-PROJECT list stays full: it's bounded and feeds export/download.
  if (!projectId) {
    const light = documents.map(d => ({ ...d, content: frontmatterOnly(d.content) }));
    return { documents: light };
  }
  return { documents };
}

/** Keep only the leading YAML frontmatter block (tags live there) — drops the
 *  potentially-huge markdown body from list payloads. */
function frontmatterOnly(content: string | undefined): string {
  const c = content || '';
  if (!c.startsWith('---')) return '';
  const end = c.indexOf('\n---', 3);
  return end === -1 ? c.slice(0, 600) : c.slice(0, end + 4);
}

export async function handleGetDocument(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const doc = await getDocument(request.docId as string);
  return { document: doc || null };
}

export async function handleDeleteDocument(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  await deleteDocument(request.docId as string);
  // Library-wide search index only auto-picks-up ADDED docs; deletions need
  // an explicit reset or stale hits point at ghosts.
  resetLibraryIndex();
  return {};
}

export async function handleGetDocumentCount(): Promise<Record<string, unknown>> {
  const count = await getDocumentCount();
  return { count };
}

export async function handleUpdateDocumentSelection(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  await updateDocumentSelection(request.docId as string, request.enabled as boolean);
  return { success: true };
}
