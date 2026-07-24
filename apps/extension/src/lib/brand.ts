// Brand constants for Magpie and Lore

export const BRAND = {
  // App identity
  name: 'Magpie',
  slug: 'magpie',           // used in tags, storage keys, DB names
  tagline: 'Your research collector',
  description: 'Magpie collects your research like a clever bird – your personal treasure trove of knowledge to search and chat with.',

  // The knowledge store's brand name (data layer)
  loreName: 'Lore',
  loreSlug: 'lore',

  // Fully-qualified defaults
  driveFolderDefault: 'Magpie',
  toolbarTitle: 'Magpie',
  htmlTitle: 'Magpie',
  offscreenTitle: 'Magpie Offscreen Parser',

  // Storage namespace (used as prefix for all storage keys)
  storagePrefix: 'magpie',           // → magpie-active-project-id
  dbNameMain: 'MagpieDB',
  dbNameResearchCache: 'MagpieResearchCacheDB',
  documentTag: 'magpie',              // frontmatter tag

  // MCP client identifier
  mcpClientName: 'magpie',
  mcpClientVersion: '1.0.0',

  // MIME boundary
  mimeBoundaryTag: '----MAGPIE_BOUNDARY',

  // LLM self-reference (used in system prompts)
  llmSelfName: 'Magpie',              // "You are Magpie, a private…"
} as const;

// Helper: build a namespaced storage key
export const brandKey = (name: string): string => `${BRAND.storagePrefix}-${name}`;
