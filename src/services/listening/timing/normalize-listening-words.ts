const APOSTROPHE_RE = /['‘’ʼ]/g;
const LEADING_PUNCT_RE = /^[.,!?;:"""''()\[\]{}\-–—]+/;
const TRAILING_PUNCT_RE = /[.,!?;:"""''()\[\]{}\-–—]+$/;

export function normalizeListeningWord(text: string): string {
  return text
    .replace(APOSTROPHE_RE, "'")
    .toLowerCase()
    .replace(LEADING_PUNCT_RE, '')
    .replace(TRAILING_PUNCT_RE, '');
}

export interface TokenWithOffset {
  text: string;
  start: number;
  end: number;
}

export function tokenizeWithOffsets(text: string): TokenWithOffset[] {
  const tokens: TokenWithOffset[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

export function tokenizeText(text: string): string[] {
  return tokenizeWithOffsets(text).map(t => t.text);
}

export function normalizeForComparison(text: string): string {
  return text
    .replace(APOSTROPHE_RE, "'")
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
