import type { ListeningPronunciationRule } from './listening-ssml-types';
import { escapeXmlForSsml } from './normalize-listening-spoken-text';

/**
 * Applies pronunciation rules to a sentence text, returning an SSML fragment
 * with the appropriate markup for special terms.
 *
 * Rules are applied in order; each term is replaced once.
 * The remaining text is XML-escaped normally.
 */
export function applyPronunciationRules(
  text: string,
  rules: ListeningPronunciationRule[],
): string {
  if (rules.length === 0) return escapeXmlForSsml(text);

  // Build a pattern that matches any of the source texts (longest first)
  const sorted = [...rules].sort((a, b) => b.sourceText.length - a.sourceText.length);
  const escaped = sorted.map(r => r.sourceText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(${escaped.join('|')})`, 'g');

  const parts: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    // Plain text before the match
    if (match.index > lastIndex) {
      parts.push(escapeXmlForSsml(text.slice(lastIndex, match.index)));
    }

    const rule = sorted.find(r => r.sourceText === match![1])!;
    parts.push(buildPronunciationElement(rule));
    lastIndex = match.index + match[1].length;
  }

  if (lastIndex < text.length) {
    parts.push(escapeXmlForSsml(text.slice(lastIndex)));
  }

  return parts.join('');
}

function buildPronunciationElement(rule: ListeningPronunciationRule): string {
  const src = escapeXmlForSsml(rule.sourceText);
  switch (rule.replacementType) {
    case 'sub':
      return `<sub alias="${escapeXmlForSsml(rule.value)}">${src}</sub>`;
    case 'say-as':
      return `<say-as interpret-as="${escapeXmlForSsml(rule.value)}">${src}</say-as>`;
    case 'phoneme':
      return `<phoneme alphabet="${escapeXmlForSsml(rule.alphabet ?? 'ipa')}" ph="${escapeXmlForSsml(rule.value)}">${src}</phoneme>`;
  }
}
