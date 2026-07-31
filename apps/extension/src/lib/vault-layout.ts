// ─────────────────────────────────────────────
// Vault layout — where a document belongs inside its project folder
// ─────────────────────────────────────────────
// The Drive folder this extension syncs into IS an Obsidian vault, and every
// project in it follows one layout:
//
//   <project>/_schemas/    shared note templates
//   <project>/captures/    things captured from somewhere else
//   <project>/decisions/   ADRs
//   <project>/research/    synthesized reports
//   <project>/specs/       specifications
//
// Sync previously dropped every document flat into `<project>/`, so a captured
// page and a deep-research report landed side by side in the project root —
// beside the folders they should have been in. Nothing was lost, but the vault
// convention was ignored and the folders stayed empty.

/** The folders every project carries. Order is only for readability. */
export const PROJECT_FOLDERS = ['_schemas', 'captures', 'decisions', 'research', 'specs'] as const;
export type ProjectFolder = (typeof PROJECT_FOLDERS)[number];

export interface DocumentLike {
  /** Source page URL. Empty for anything Magpie synthesized itself. */
  url?: string;
  title?: string;
  /** Raw scrape kept only for citation links during deep research. */
  isResearchSource?: boolean;
  /** `type:` from the document's own frontmatter, when it has one. */
  frontmatterType?: string;
}

/** Frontmatter types this extension writes, mapped to where they belong. */
const BY_TYPE: Record<string, ProjectFolder> = {
  'web-capture': 'captures',
  'pdf': 'captures',
  'selection': 'captures',
  'image': 'captures',
  'local-import': 'captures',
  'research-sources': 'research',
  'syllabus': 'research',
  'flashcards': 'research',
};

/** Read `type:` out of a document's YAML frontmatter, if it has any. */
export function frontmatterType(content: string): string | undefined {
  if (!content.startsWith('---')) return undefined;
  const end = content.indexOf('\n---', 3);
  if (end < 0) return undefined;
  const m = content.slice(0, end).match(/^type:\s*["']?([\w-]+)["']?\s*$/m);
  return m?.[1];
}

/**
 * The project subfolder a document belongs in.
 *
 * Frontmatter first — it is what the writer explicitly declared. Falling back
 * to the URL is a guess, but a reliable one: a document with a real source URL
 * came from somewhere else, and one without was written here.
 */
export function folderForDocument(doc: DocumentLike): ProjectFolder {
  const declared = doc.frontmatterType && BY_TYPE[doc.frontmatterType];
  if (declared) return declared;

  // Raw scrapes kept for citations are captured material, not a report.
  if (doc.isResearchSource) return 'captures';

  const url = (doc.url || '').trim();
  if (/^https?:\/\//i.test(url)) return 'captures';

  // Title conventions from the deep-research and spec writers, for older
  // documents saved before frontmatter carried a type.
  const title = (doc.title || '').toLowerCase();
  if (/^(spec|specification)\b|—\s*spec$/.test(title)) return 'specs';
  if (/^(adr|decision)\b/.test(title)) return 'decisions';

  return 'research';
}
