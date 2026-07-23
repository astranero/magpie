import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('chat model-catalog efficiency guard', () => {
  const appSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'App.tsx'),
    'utf8',
  );

  it('keeps model entries and refresh callback stable across stream renders', () => {
    expect(appSource).toContain('const modelEntries = useMemo(');
    expect(appSource).toContain('const refreshChatModels = useCallback(');
    expect(appSource).toContain('modelEntries={modelEntries}');
    expect(appSource).toContain('onRefreshModels={refreshChatModels}');
    expect(appSource).not.toMatch(/onRefreshModels=\{async\s*\(\)/);
  });
});
