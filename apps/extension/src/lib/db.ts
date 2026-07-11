// ─────────────────────────────────────────────
// IndexedDB Storage Layer — AI Research Assistant
// ─────────────────────────────────────────────
// Local-first document storage with semantic chunks.
// No external dependencies — pure IndexedDB API.

import { BRAND } from './brand';
import { sendToOffscreen } from './offscreen-client';

const DB_NAME = BRAND.dbNameMain;
const DB_VERSION = 3;

// ── Types ──

export interface Project {
  id: string;
  title: string;
  documentIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Chat {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredDocument {
  id: string;
  projectId?: string; // Legacy field for backwards compatibility
  title: string;
  url: string;
  content: string;       // full markdown
  capturedAt: string;     // ISO timestamp
  favicon?: string;
  wordCount: number;
  syncedToDrive: boolean;
  enabled: boolean;
  driveFileId?: string;
  /** BibTeX entry — present on academic papers with known metadata. */
  bibtex?: string;
}

export interface Chunk {
  id: string;
  docId: string;
  chunkIndex: number;
  text: string;
  heading: string;        // nearest heading
  sectionPath: string;    // e.g. "Introduction > Background"
  paragraphIndex: number;
  anchorId: string;       // e.g. "d3.s2.p4"
  charStart: number;
  charEnd: number;
  embedding?: number[];
}

export interface ChatMessage {
  id: string;
  chatId: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  citations?: CitationRef[];
  timestamp: string;
  provider?: string;
}

export interface CitationRef {
  anchorId: string;
  docId: string;
  docTitle: string;
  docUrl: string;
  chunkText: string;
  sectionPath: string;
}

// ── Database Connection ──

let dbInstance: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      const tx = (event.target as IDBOpenDBRequest).transaction!;

      // ── V3 Migration logic ──
      // Projects store
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' });
      }
      
      // Chats store
      if (!db.objectStoreNames.contains('chats')) {
        const chatsStore = db.createObjectStore('chats', { keyPath: 'id' });
        chatsStore.createIndex('projectId', 'projectId', { unique: false });
      } else {
        const chatsStore = tx.objectStore('chats');
        if (!chatsStore.indexNames.contains('projectId')) {
          chatsStore.createIndex('projectId', 'projectId', { unique: false });
        }
      }

      // Migrate documents to use projectId
      if (!db.objectStoreNames.contains('documents')) {
        const docStore = db.createObjectStore('documents', { keyPath: 'id' });
        docStore.createIndex('capturedAt', 'capturedAt', { unique: false });
        docStore.createIndex('url', 'url', { unique: false });
        docStore.createIndex('syncedToDrive', 'syncedToDrive', { unique: false });
        docStore.createIndex('projectId', 'projectId', { unique: false });
      } else {
        const docStore = tx.objectStore('documents');
        if (!docStore.indexNames.contains('projectId')) {
          docStore.createIndex('projectId', 'projectId', { unique: false });
        }
        if (event.oldVersion < 3) {
          docStore.openCursor().onsuccess = (e) => {
            const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
            if (cursor) {
              const doc = cursor.value;
              if (doc.sessionId && !doc.projectId) {
                doc.projectId = doc.sessionId;
                delete doc.sessionId;
                cursor.update(doc);
              }
              cursor.continue();
            }
          };
        }
      }

      // Chunks store
      if (!db.objectStoreNames.contains('chunks')) {
        const chunkStore = db.createObjectStore('chunks', { keyPath: 'id' });
        chunkStore.createIndex('docId', 'docId', { unique: false });
        chunkStore.createIndex('anchorId', 'anchorId', { unique: true });
      }

      // Settings store
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }

      // Migrate chatHistory to use chatId
      if (!db.objectStoreNames.contains('chatHistory')) {
        const chatStore = db.createObjectStore('chatHistory', { keyPath: 'id' });
        chatStore.createIndex('chatId', 'chatId', { unique: false });
        chatStore.createIndex('timestamp', 'timestamp', { unique: false });
      } else {
        const chatStore = tx.objectStore('chatHistory');
        if (!chatStore.indexNames.contains('chatId')) {
          chatStore.createIndex('chatId', 'chatId', { unique: false });
        }
        if (event.oldVersion < 3) {
          chatStore.openCursor().onsuccess = (e) => {
            const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
            if (cursor) {
              const msg = cursor.value;
              if (msg.sessionId && !msg.chatId) {
                msg.chatId = msg.sessionId;
                delete msg.sessionId;
                cursor.update(msg);
              }
              cursor.continue();
            }
          };
        }
      }

      // Migrate sessions -> projects + default chat
      if (event.oldVersion < 3 && db.objectStoreNames.contains('sessions')) {
        const projectStore = tx.objectStore('projects');
        const chatStore = tx.objectStore('chats');
        const sessionStore = tx.objectStore('sessions');
        sessionStore.openCursor().onsuccess = (e) => {
          const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor) {
            const session = cursor.value;
            projectStore.put({ id: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt });
            chatStore.put({ id: session.id, projectId: session.id, title: 'Main Chat', createdAt: session.createdAt, updatedAt: session.updatedAt });
            cursor.continue();
          }
        };
      }
    };

    request.onsuccess = (event) => {
      dbInstance = (event.target as IDBOpenDBRequest).result;
      dbInstance.onclose = () => { dbInstance = null; };
      resolve(dbInstance);
    };

    request.onerror = () => {
      reject(new Error(`Failed to open IndexedDB: ${request.error?.message}`));
    };
  });
}

// ── Helpers ──

function generateId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function tx(
  db: IDBDatabase,
  storeName: string | string[],
  mode: IDBTransactionMode = 'readonly'
): IDBTransaction {
  return db.transaction(storeName, mode);
}

function reqToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted'));
  });
}

const syncChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('ai_research_assistant_sync') : null;
function notifySync() {
  if (syncChannel) syncChannel.postMessage('SYNC_STATE');
}

// ── Project Operations ──

export async function createProject(title: string): Promise<string> {
  const db = await openDB();
  const id = generateId();
  const now = new Date().toISOString();
  const project: Project = { id, title, documentIds: [], createdAt: now, updatedAt: now };

  // Also create a default chat
  const chat: Chat = { id, projectId: id, title: 'Main Chat', createdAt: now, updatedAt: now };

  const transaction = tx(db, ['projects', 'chats'], 'readwrite');
  transaction.objectStore('projects').put(project);
  transaction.objectStore('chats').put(chat);
  await txComplete(transaction);
  notifySync();
  return id;
}

export async function listProjects(): Promise<Project[]> {
  const db = await openDB();
  const transaction = tx(db, 'projects');
  const store = transaction.objectStore('projects');
  const projects = await reqToPromise<Project[]>(store.getAll());
  return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getProject(id: string): Promise<Project | undefined> {
  const db = await openDB();
  const transaction = tx(db, 'projects');
  const store = transaction.objectStore('projects');
  return reqToPromise<Project | undefined>(store.get(id));
}

export async function updateProjectTitle(id: string, title: string): Promise<void> {
  const db = await openDB();
  const transaction = tx(db, 'projects', 'readwrite');
  const store = transaction.objectStore('projects');
  const project = await reqToPromise<Project | undefined>(store.get(id));
  if (project) {
    project.title = title;
    project.updatedAt = new Date().toISOString();
    store.put(project);
  }
  await txComplete(transaction);
  notifySync();
}

export async function linkDocumentToProject(projectId: string, documentId: string): Promise<void> {
  const db = await openDB();
  const transaction = tx(db, 'projects', 'readwrite');
  const store = transaction.objectStore('projects');
  const project = await reqToPromise<Project | undefined>(store.get(projectId));
  if (project) {
    if (!project.documentIds) project.documentIds = [];
    if (!project.documentIds.includes(documentId)) {
      project.documentIds.push(documentId);
      project.updatedAt = new Date().toISOString();
      store.put(project);
    }
  }
  await txComplete(transaction);
  notifySync();
}

export async function unlinkDocumentFromProject(projectId: string, documentId: string): Promise<void> {
  const db = await openDB();
  const transaction = tx(db, 'projects', 'readwrite');
  const store = transaction.objectStore('projects');
  const project = await reqToPromise<Project | undefined>(store.get(projectId));
  if (project && project.documentIds) {
    project.documentIds = project.documentIds.filter(id => id !== documentId);
    project.updatedAt = new Date().toISOString();
    store.put(project);
  }
  await txComplete(transaction);
  notifySync();
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDB();

  // First, fetch the project to get its documentIds (V3 architecture).
  // Do this before opening the write transaction — IDB transactions
  // auto-commit if you await across microtask boundaries inside them.
  const readTx = tx(db, 'projects');
  const project = await reqToPromise<Project | undefined>(readTx.objectStore('projects').get(id));
  const linkedDocIds: string[] = project?.documentIds ?? [];

  // Collect all doc IDs to delete — linked ones from documentIds array,
  // plus any legacy docs that still carry the old projectId field.
  const legacyReadTx = tx(db, 'documents');
  const legacyDocIds = await reqToPromise<IDBValidKey[]>(
    legacyReadTx.objectStore('documents').index('projectId').getAllKeys(id)
  );
  const docIdsToDelete = Array.from(new Set([...linkedDocIds, ...(legacyDocIds as string[])]));

  const transaction = tx(db, ['projects', 'chats', 'documents', 'chunks', 'chatHistory'], 'readwrite');

  // 1. Delete project record
  transaction.objectStore('projects').delete(id);

  // 2. Delete chats and their history
  const chatStore = transaction.objectStore('chats');
  const chatHistoryStore = transaction.objectStore('chatHistory');
  const chatProjectIdIndex = chatStore.index('projectId');
  const chatHistoryChatIdIndex = chatHistoryStore.index('chatId');

  const chatKeys = await reqToPromise<IDBValidKey[]>(chatProjectIdIndex.getAllKeys(id));
  for (const cKey of chatKeys) {
    chatStore.delete(cKey);
    const histKeys = await reqToPromise<IDBValidKey[]>(chatHistoryChatIdIndex.getAllKeys(cKey));
    for (const hKey of histKeys) chatHistoryStore.delete(hKey);
  }

  // 3. Delete documents and their chunks (V3: use documentIds array)
  const docStore = transaction.objectStore('documents');
  const chunkStore = transaction.objectStore('chunks');
  const chunkDocIdIndex = chunkStore.index('docId');

  for (const dId of docIdsToDelete) {
    docStore.delete(dId);
    const cKeys = await reqToPromise<IDBValidKey[]>(chunkDocIdIndex.getAllKeys(dId));
    for (const cKey of cKeys) chunkStore.delete(cKey);
  }

  await txComplete(transaction);
  notifySync();
}

/**
 * Delete all documents not linked to any workspace.
 * Returns the count of deleted documents.
 */
export async function deleteOrphanDocuments(): Promise<number> {
  const db = await openDB();

  // Collect all doc IDs that are linked to at least one project
  const projectsTx = tx(db, 'projects');
  const allProjects = await reqToPromise<Project[]>(projectsTx.objectStore('projects').getAll());
  const linkedIds = new Set<string>();
  for (const p of allProjects) {
    for (const id of p.documentIds ?? []) linkedIds.add(id);
  }

  // Get all document IDs
  const docReadTx = tx(db, 'documents');
  const allDocIds = await reqToPromise<IDBValidKey[]>(docReadTx.objectStore('documents').getAllKeys());

  const orphanIds = (allDocIds as string[]).filter(id => !linkedIds.has(id));
  if (orphanIds.length === 0) return 0;

  // Delete orphans + their chunks
  const writeTx = tx(db, ['documents', 'chunks'], 'readwrite');
  const docStore = writeTx.objectStore('documents');
  const chunkStore = writeTx.objectStore('chunks');
  const chunkIdx = chunkStore.index('docId');

  for (const id of orphanIds) {
    docStore.delete(id);
    const cKeys = await reqToPromise<IDBValidKey[]>(chunkIdx.getAllKeys(id));
    for (const cKey of cKeys) chunkStore.delete(cKey);
  }

  await txComplete(writeTx);
  notifySync();
  return orphanIds.length;
}

// ── Chat Operations ──

export async function createChat(projectId: string, title: string): Promise<string> {
  const db = await openDB();
  const id = generateId();
  const now = new Date().toISOString();
  const chat: Chat = { id, projectId, title, createdAt: now, updatedAt: now };

  const transaction = tx(db, 'chats', 'readwrite');
  transaction.objectStore('chats').put(chat);
  await txComplete(transaction);
  notifySync();
  return id;
}

export async function listChats(projectId: string): Promise<Chat[]> {
  const db = await openDB();
  const transaction = tx(db, 'chats');
  const store = transaction.objectStore('chats');
  const index = store.index('projectId');
  const chats = await reqToPromise<Chat[]>(index.getAll(projectId));
  return chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function updateChatTitle(id: string, title: string): Promise<void> {
  const db = await openDB();
  const transaction = tx(db, 'chats', 'readwrite');
  const store = transaction.objectStore('chats');
  const chat = await reqToPromise<Chat | undefined>(store.get(id));
  if (chat) {
    chat.title = title;
    chat.updatedAt = new Date().toISOString();
    store.put(chat);
  }
  await txComplete(transaction);
  notifySync();
}

export async function deleteChat(id: string): Promise<void> {
  const db = await openDB();
  const transaction = tx(db, ['chats', 'chatHistory'], 'readwrite');
  
  transaction.objectStore('chats').delete(id);

  const historyStore = transaction.objectStore('chatHistory');
  const index = historyStore.index('chatId');
  const keys = await reqToPromise<IDBValidKey[]>(index.getAllKeys(id));
  for (const key of keys) {
    historyStore.delete(key);
  }

  await txComplete(transaction);
  notifySync();
}

// ── Document Operations ──

export interface SaveDocumentResult {
  id: string;
  /** Chunks with their final `id` and `docId` assigned — use these for vector indexing. */
  chunks: Chunk[];
  isDuplicate?: boolean;
  existingId?: string;
}

/**
 * Check if a document with the same URL already exists.
 * Uses the URL as the canonical deduplication key.
 */
export async function findExistingDocumentByUrl(url: string): Promise<StoredDocument | undefined> {
  const db = await openDB();
  const transaction = tx(db, 'documents');
  const store = transaction.objectStore('documents');
  // The `url` index makes this an O(log n) lookup — a getAll() scan here ran
  // on EVERY document save and loaded the full library into memory.
  return reqToPromise<StoredDocument | undefined>(store.index('url').get(url));
}

export async function saveDocument(
  doc: Omit<StoredDocument, 'id' | 'enabled'> & { enabled?: boolean },
  chunks: Omit<Chunk, 'id' | 'docId'>[]
): Promise<SaveDocumentResult> {
  // Deduplication: check if document with same URL already exists
  if (doc.url) {
    const existing = await findExistingDocumentByUrl(doc.url);
    if (existing) {
      console.log(`[DB] Document with URL already exists, skipping: ${doc.url}`);
      return { id: existing.id, chunks: [], isDuplicate: true, existingId: existing.id };
    }
  }

  const db = await openDB();
  const id = generateId();

  const finalChunks: Chunk[] = chunks.map(chunk => ({ ...chunk, id: generateId(), docId: id }));

  // Generate embeddings BEFORE opening the IDB transaction.
  // Using robust offscreen client with auto-retry on failure.
  try {
    const res: any = await sendToOffscreen({ action: 'OFFSCREEN_GET_EMBEDDINGS', texts: finalChunks.map(c => c.text) });
    if (res?.ok && Array.isArray(res.embeddings)) {
      res.embeddings.forEach((embedding: number[], idx: number) => {
        if (finalChunks[idx]) finalChunks[idx].embedding = embedding;
      });
    }
  } catch (e) {
    console.warn('Failed to generate embeddings in saveDocument, saving chunks without vectors', e);
  }

  // Now open the transaction and write everything synchronously
  const transaction = tx(db, ['documents', 'chunks'], 'readwrite');
  const docStore = transaction.objectStore('documents');
  const chunkStore = transaction.objectStore('chunks');

  docStore.put({ ...doc, id, enabled: doc.enabled ?? true });

  for (const chunk of finalChunks) {
    chunkStore.put(chunk);
  }

  await txComplete(transaction);
  notifySync();
  return { id, chunks: finalChunks };
}

/**
 * Replace ALL chunks of a document (re-chunk/re-embed pass). Old chunks are
 * deleted and the new set inserted in one transaction. Returns the saved
 * chunks with their assigned ids.
 */
export async function replaceChunksForDoc(docId: string, chunks: Omit<Chunk, 'id' | 'docId'>[]): Promise<Chunk[]> {
  const db = await openDB();
  const finalChunks: Chunk[] = chunks.map(c => ({ ...c, id: generateId(), docId }));
  const transaction = tx(db, 'chunks', 'readwrite');
  const store = transaction.objectStore('chunks');
  const index = store.index('docId');
  await new Promise<void>((resolve, reject) => {
    const cursorReq = index.openCursor(IDBKeyRange.only(docId));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
      else {
        for (const c of finalChunks) store.put(c);
        resolve();
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  return finalChunks;
}

export async function listDocuments(projectId?: string): Promise<StoredDocument[]> {
  const db = await openDB();
  let docs: StoredDocument[] = [];
  
  if (projectId) {
    const project = await getProject(projectId);
    if (!project || !project.documentIds || project.documentIds.length === 0) return [];
    
    const transaction = tx(db, 'documents');
    const store = transaction.objectStore('documents');
    docs = await Promise.all(
      project.documentIds.map(id => reqToPromise<StoredDocument | undefined>(store.get(id)))
    ) as StoredDocument[];
    docs = docs.filter(Boolean); // Remove undefined if a document was deleted but still linked
  } else {
    const transaction = tx(db, 'documents');
    const store = transaction.objectStore('documents');
    docs = await reqToPromise<StoredDocument[]>(store.getAll());
  }
  
  // Sort by capturedAt descending
  return docs.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
}

export async function getDocument(id: string): Promise<StoredDocument | undefined> {
  const db = await openDB();
  const transaction = tx(db, 'documents');
  const store = transaction.objectStore('documents');
  return reqToPromise<StoredDocument | undefined>(store.get(id));
}

export async function deleteDocument(id: string): Promise<void> {
  const db = await openDB();
  const transaction = tx(db, ['documents', 'chunks'], 'readwrite');
  const docStore = transaction.objectStore('documents');
  const chunkStore = transaction.objectStore('chunks');

  // Delete document
  docStore.delete(id);

  // Delete all chunks for this document
  const chunkIndex = chunkStore.index('docId');
  const chunkKeys = await reqToPromise<IDBValidKey[]>(chunkIndex.getAllKeys(id));
  for (const key of chunkKeys) {
    chunkStore.delete(key);
  }

  await txComplete(transaction);
  notifySync();
}

export async function updateDocumentSync(
  id: string,
  syncedToDrive: boolean,
  driveFileId?: string
): Promise<void> {
  const db = await openDB();
  const transaction = tx(db, 'documents', 'readwrite');
  const store = transaction.objectStore('documents');

  const doc = await reqToPromise<StoredDocument | undefined>(store.get(id));
  if (doc) {
    doc.syncedToDrive = syncedToDrive;
    if (driveFileId) doc.driveFileId = driveFileId;
    store.put(doc);
  }

  await txComplete(transaction);
  notifySync();
}

export async function updateDocumentSelection(id: string, enabled: boolean): Promise<void> {
  const db = await openDB();
  const transaction = tx(db, 'documents', 'readwrite');
  const store = transaction.objectStore('documents');

  const doc = await reqToPromise<StoredDocument | undefined>(store.get(id));
  if (doc) {
    doc.enabled = enabled;
    store.put(doc);
  }

  await txComplete(transaction);
  notifySync();
}

export async function updateDocumentContent(
  id: string,
  content: string,
  chunks: Omit<Chunk, 'id' | 'docId'>[],
  capturedAt?: string
): Promise<Chunk[]> {
  const db = await openDB();

  // Prepare chunks and generate embeddings BEFORE opening the IDB transaction.
  const finalChunks: Chunk[] = chunks.map(chunk => ({ ...chunk, id: generateId(), docId: id }));

  try {
    let res: any = await chrome.runtime.sendMessage({ action: 'OFFSCREEN_GET_EMBEDDINGS', texts: finalChunks.map(c => c.text) });
    if (!res?.ok) {
      await chrome.runtime.sendMessage({ action: 'ENSURE_OFFSCREEN' });
      res = await chrome.runtime.sendMessage({ action: 'OFFSCREEN_GET_EMBEDDINGS', texts: finalChunks.map(c => c.text) });
    }
    if (res?.ok && Array.isArray(res.embeddings)) {
      res.embeddings.forEach((embedding: number[], idx: number) => {
        if (finalChunks[idx]) finalChunks[idx].embedding = embedding;
      });
    }
  } catch (e) {
    console.warn('Failed to generate embeddings in updateDocumentContent, saving chunks without vectors', e);
  }

  // Now open the transaction and write everything synchronously
  const transaction = tx(db, ['documents', 'chunks'], 'readwrite');
  const docStore = transaction.objectStore('documents');
  const chunkStore = transaction.objectStore('chunks');

  const doc = await reqToPromise<StoredDocument | undefined>(docStore.get(id));
  if (!doc) throw new Error('Document not found');

  doc.content = content;
  doc.capturedAt = capturedAt || new Date().toISOString();
  docStore.put(doc);

  // Delete old chunks
  const chunkIndex = chunkStore.index('docId');
  const chunkKeys = await reqToPromise<IDBValidKey[]>(chunkIndex.getAllKeys(id));
  for (const key of chunkKeys) {
    chunkStore.delete(key);
  }

  // Insert new chunks (with embeddings already computed)
  for (const chunk of finalChunks) {
    chunkStore.put(chunk);
  }

  await txComplete(transaction);
  notifySync();
  return finalChunks;
}

export async function getDocumentCount(): Promise<number> {
  const db = await openDB();
  const transaction = tx(db, 'documents');
  const store = transaction.objectStore('documents');
  return reqToPromise<number>(store.count());
}

// ── Chunk Operations ──

/**
 * Save chunks directly to the chunks store without a parent document record.
 * Used by ephemeral deep-research sources so that citation anchor lookups
 * (getChunkByAnchor) resolve during the research session.
 * Call deleteChunksByDocId to clean up after the session ends.
 */
export async function saveChunksOnly(chunks: Chunk[]): Promise<void> {
  if (chunks.length === 0) return;
  const db = await openDB();
  const transaction = tx(db, 'chunks', 'readwrite');
  const store = transaction.objectStore('chunks');
  for (const chunk of chunks) {
    store.put(chunk);
  }
  await txComplete(transaction);
}

/**
 * Delete all chunks whose docId is in the provided set.
 * Used to clean up ephemeral research-source chunks after a run completes.
 */
export async function deleteChunksByDocIds(docIds: string[]): Promise<void> {
  if (docIds.length === 0) return;
  const db = await openDB();
  const transaction = tx(db, 'chunks', 'readwrite');
  const store = transaction.objectStore('chunks');
  const index = store.index('docId');
  for (const docId of docIds) {
    const keys = await reqToPromise<IDBValidKey[]>(index.getAllKeys(docId));
    for (const key of keys) {
      store.delete(key);
    }
  }
  await txComplete(transaction);
}

export async function getChunksForDoc(docId: string): Promise<Chunk[]> {
  const db = await openDB();
  const transaction = tx(db, 'chunks');
  const store = transaction.objectStore('chunks');
  const index = store.index('docId');
  const chunks = await reqToPromise<Chunk[]>(index.getAll(docId));
  return chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
}

export async function getChunksForDocs(docIds: string[]): Promise<Chunk[]> {
  if (docIds.length === 0) return [];
  // F8: single readonly transaction, parallel index.getAll() per docId.
  // Prior implementation opened a new transaction per docId; deep-research
  // rehydration with 50+ sources spent tens of ms per doc on tx setup alone.
  const db = await openDB();
  const transaction = tx(db, 'chunks');
  const index = transaction.objectStore('chunks').index('docId');
  const perDoc = await Promise.all(
    docIds.map(id => reqToPromise<Chunk[]>(index.getAll(id)))
  );
  const all: Chunk[] = [];
  for (const chunks of perDoc) all.push(...chunks);
  return all;
}

export async function getAllChunks(): Promise<Chunk[]> {
  const db = await openDB();
  const transaction = tx(db, 'chunks');
  const store = transaction.objectStore('chunks');
  return reqToPromise<Chunk[]>(store.getAll());
}

export async function getChunkByAnchor(anchorId: string): Promise<Chunk | undefined> {
  const db = await openDB();
  const transaction = tx(db, 'chunks');
  const store = transaction.objectStore('chunks');
  const index = store.index('anchorId');
  return reqToPromise<Chunk | undefined>(index.get(anchorId));
}

export async function searchChunks(query: string): Promise<Chunk[]> {
  const allChunks = await getAllChunks();
  const lowerQuery = query.toLowerCase();
  const terms = lowerQuery.split(/\s+/).filter(t => t.length > 2);

  return allChunks
    .map(chunk => {
      const lowerText = chunk.text.toLowerCase();
      const lowerHeading = chunk.heading.toLowerCase();
      let score = 0;

      // Exact substring match
      if (lowerText.includes(lowerQuery)) score += 10;
      if (lowerHeading.includes(lowerQuery)) score += 15;

      // Individual term matches
      for (const term of terms) {
        if (lowerText.includes(term)) score += 2;
        if (lowerHeading.includes(term)) score += 3;
      }

      return { chunk, score };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(r => r.chunk);
}

// ── Settings Operations ──

export async function getSetting<T = string>(key: string): Promise<T | undefined> {
  const db = await openDB();
  const transaction = tx(db, 'settings');
  const store = transaction.objectStore('settings');
  const result = await reqToPromise<{ key: string; value: T } | undefined>(store.get(key));
  return result?.value;
}

export async function setSetting<T = string>(key: string, value: T): Promise<void> {
  const db = await openDB();
  const transaction = tx(db, 'settings', 'readwrite');
  const store = transaction.objectStore('settings');
  store.put({ key, value });
  await txComplete(transaction);
}

// ── Chat History Operations ──

export async function saveChatMessage(msg: Omit<ChatMessage, 'id'>): Promise<string> {
  const db = await openDB();
  const id = generateId();
  const transaction = tx(db, 'chatHistory', 'readwrite');
  const store = transaction.objectStore('chatHistory');
  store.put({ ...msg, id });
  await txComplete(transaction);
  notifySync();
  return id;
}

export async function getChatHistory(chatId: string): Promise<ChatMessage[]> {
  const db = await openDB();
  const transaction = tx(db, 'chatHistory');
  const store = transaction.objectStore('chatHistory');
  const index = store.index('chatId');
  const messages = await reqToPromise<ChatMessage[]>(index.getAll(chatId));
  return messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export async function clearChatHistory(chatId: string): Promise<void> {
  const db = await openDB();
  const transaction = tx(db, 'chatHistory', 'readwrite');
  const store = transaction.objectStore('chatHistory');
  const index = store.index('chatId');
  const keys = await reqToPromise<IDBValidKey[]>(index.getAllKeys(chatId));
  for (const key of keys) {
    store.delete(key);
  }
  await txComplete(transaction);
  notifySync();
}

// ── Bulk Operations ──

export async function getUnsyncedDocuments(): Promise<StoredDocument[]> {
  const docs = await listDocuments();
  return docs.filter(d => !d.syncedToDrive);
}

export async function getDocumentWithChunks(docId: string): Promise<{
  doc: StoredDocument;
  chunks: Chunk[];
} | undefined> {
  const doc = await getDocument(docId);
  if (!doc) return undefined;
  const chunks = await getChunksForDoc(docId);
  return { doc, chunks };
}
