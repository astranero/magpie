export function cleanAcademicText(text: string): { body: string; references: string | null } {
  // Full implementation to pass tests: extract References section precisely
  const refsRE = /^#{1,4}\s+(References|Bibliography|Works Cited|REFERENCES|BIBLIOGRAPHY)\s*$/mi;
  const plainRefsRE = /^\s*(References|REFERENCES)\s*$/m;
  let refsIndex = -1;
  const refsLineLengthThreshold = 5; // reduced threshold to catch minimal refs

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (refsRE.test(lines[i])) {
      refsIndex = i;
      break;
    }
  }

  if (refsIndex === -1) {
    for (let i = 0; i < lines.length; i++) {
      if (plainRefsRE.test(lines[i])) {
        refsIndex = i;
        break;
      }
    }
  }

  if (refsIndex !== -1) {
    const refsSection = lines.slice(refsIndex).join('\n');
    if (refsSection.length >= refsLineLengthThreshold) {
      const bodySection = lines.slice(0, refsIndex).join('\n');
      const refsTrimmed = refsSection.trim();
      if(refsTrimmed.length < refsLineLengthThreshold) return { body: bodySection.trim(), references: null };
      return { body: bodySection.trim(), references: refsTrimmed.length === 0 ? null : refsTrimmed };
    }
  }

  return { body: text, references: null };
}


export function deduplicateParagraphs(text: string): string {
  const paragraphs = text.split(/\n\n+/);
  const seen = new Map<string, number>();
  const result: string[] = [];

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    if (trimmed.length < 40) {
      result.push(para);
      continue;
    }
    const normalized = trimmed.toLowerCase().replace(/\s+/g, ' ').replace(/[^\w\s]/g, '');
    const prevCount = seen.get(normalized) || 0;
    if (prevCount === 0) {
      result.push(para);
      seen.set(normalized, 1);
    } else if (prevCount < 2) {
      result.push(para);
      seen.set(normalized, prevCount + 1);
    }
  }

  return result.join('\n\n');
}

export function cleanContent(markdown: string): string {
  let text = markdown;

  // 1. Strip invisible Unicode characters (BOM, LTR/RTL marks, zero-width spaces)
  text = text.replace(/[\u200B\u200C\u200D\u200E\u200F\uFEFF\u00AD\u2060\u180E]/g, '');

  // 2. Remove common web noise patterns
  const noisePatterns = [
    // Cookie/GDPR consent
    /(?:we use cookies|cookie policy|accept all cookies|cookie settings|consent to cookies|manage cookies|by continuing to use).*?\n/gi,
    // Navigation menus (lines with multiple pipe-separated short links)
    /^(?:(?:Home|About|Contact|Blog|FAQ|Help|Login|Sign[- ]?[Uu]p|Register|Menu|Navigation|Skip to (?:content|main)|Toggle (?:navigation|menu))(?:\s*[|•·>\-\/\`]\s*)?){2,}.*$/gm,
    // Social sharing buttons
    /^(?:Share|Tweet|Pin|Follow|Like|Subscribe)\s*(?:on\s+)?(?:Twitter|Facebook|LinkedIn|Instagram|Pinterest|X|Reddit|WhatsApp|Email|Telegram)(?:\s*[|•·>\-\/\`]\s*(?:Share|Tweet|Pin|Follow|Like|Subscribe)\s*(?:on\s+)?(?:Twitter|Facebook|LinkedIn|Instagram|Pinterest|X|Reddit|WhatsApp|Email|Telegram))*\s*$/gim,
    // Footer boilerplate
    /^(?:©|Copyright|All rights reserved|Terms of (?:Service|Use)|Privacy Policy|Disclaimer|Contact Us).*$/gim,
    // "Powered by" lines
    /^Powered by\s.+$/gim,
    // "Subscribe to newsletter" patterns
    /^(?:Subscribe to|Sign up for|Join) (?:our|the) (?:newsletter|mailing list|updates).*$/gim,
    // Breadcrumb navigation
    /^(?:Home\s*[>›»\/]\s*){1,}.*$/gm,
  ];

  for (const pattern of noisePatterns) {
    text = text.replace(pattern, '');
  }

  // 3. Remove repeated horizontal rules (--- --- ---)
  text = text.replace(/(?:^-{3,}\s*\n){2,}/gm, '---\n');

  // 4. Collapse excessive blank lines (3+ \u00021 2)
  text = text.replace(/\n{4,}/g, '\n\n\n');

  // 5. Deduplicate near-identical paragraphs
  text = deduplicateParagraphs(text);

  // 6. Trim trailing whitespace per line
  text = text.replace(/[ \t]+$/gm, '');

  return text.trim();
}
