import type { ListeningSsmlBookmarkValidation } from './listening-ssml-types';
import type { ListeningSentence } from '../../domain/listening/listening-types';

function extractBookmarkMarks(ssml: string): string[] {
  const marks: string[] = [];
  const pattern = /<bookmark\s+mark="([^"]+)"\s*\/>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(ssml)) !== null) {
    marks.push(match[1]);
  }
  return marks;
}

export function validateListeningSsmlBookmarks(
  ssml: string,
  sentences: Pick<ListeningSentence, 'sentenceKey' | 'sentenceOrder'>[],
  blockOrder: 1 | 2,
): ListeningSsmlBookmarkValidation {
  const sorted = [...sentences].sort((a, b) => a.sentenceOrder - b.sentenceOrder);
  const expectedMarks = [
    `block-${blockOrder}-start`,
    ...sorted.map(s => s.sentenceKey),
    `block-${blockOrder}-end`,
  ];

  const actualMarks = extractBookmarkMarks(ssml);
  const expectedSet = new Set(expectedMarks);
  const actualSet = new Set(actualMarks);

  const missing = expectedMarks.filter(m => !actualSet.has(m));

  const seen = new Set<string>();
  const duplicated: string[] = [];
  for (const m of actualMarks) {
    if (seen.has(m)) {
      if (!duplicated.includes(m)) duplicated.push(m);
    } else {
      seen.add(m);
    }
  }

  const unexpected = [...new Set(actualMarks.filter(m => !expectedSet.has(m)))];

  // Check order using first-occurrence positions of expected marks
  const firstOccurrence = new Map<string, number>();
  actualMarks.forEach((m, i) => {
    if (expectedSet.has(m) && !firstOccurrence.has(m)) {
      firstOccurrence.set(m, i);
    }
  });

  const outOfOrder: string[] = [];
  let prevPos = -1;
  for (const expected of expectedMarks) {
    const pos = firstOccurrence.get(expected);
    if (pos !== undefined) {
      if (pos < prevPos) {
        outOfOrder.push(expected);
      } else {
        prevPos = pos;
      }
    }
  }

  const valid =
    missing.length === 0 &&
    duplicated.length === 0 &&
    unexpected.length === 0 &&
    outOfOrder.length === 0;

  return {
    valid,
    expectedCount: expectedMarks.length,
    actualCount: actualMarks.length,
    missing,
    duplicated,
    unexpected,
    outOfOrder,
  };
}
