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
  const documents = await listDocuments(request.projectId as string);
  return { documents };
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
