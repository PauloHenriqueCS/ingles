import type { ListeningSentence } from '../../domain/listening/listening-types';
import type { ListeningSsmlConfig } from './listening-ssml-types';
import { applyPronunciationRules } from './apply-listening-pronunciation-rules';

export function buildListeningSsmlBlock(
  sentences: ListeningSentence[],
  blockOrder: 1 | 2,
  config: ListeningSsmlConfig,
): string {
  const sorted = [...sentences].sort((a, b) => a.sentenceOrder - b.sentenceOrder);
  const { voice, pauses, prosody, pronunciationRules } = config;

  const lines: string[] = [];
  lines.push(`<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${voice.locale}">`);
  lines.push(`  <voice name="${voice.voiceName}">`);

  if (pauses.blockStartMs > 0) {
    lines.push(`    <break time="${pauses.blockStartMs}ms"/>`);
  }

  lines.push(`    <bookmark mark="block-${blockOrder}-start"/>`);

  const innerIndent = prosody ? '      ' : '    ';

  if (prosody) {
    lines.push(`    <prosody rate="${prosody.rate}">`);
  }

  let prevParagraphOrder: number | null = null;

  for (const sentence of sorted) {
    if (prevParagraphOrder !== null && sentence.paragraphOrder !== prevParagraphOrder) {
      lines.push(`${innerIndent}<break time="${pauses.paragraphBreakMs}ms"/>`);
    }
    const spokenText = applyPronunciationRules(sentence.textEn, pronunciationRules);
    lines.push(`${innerIndent}<bookmark mark="${sentence.sentenceKey}"/>${spokenText}`);
    prevParagraphOrder = sentence.paragraphOrder;
  }

  if (prosody) {
    lines.push(`    </prosody>`);
  }

  lines.push(`    <bookmark mark="block-${blockOrder}-end"/>`);
  lines.push(`  </voice>`);
  lines.push(`</speak>`);

  return lines.join('\n');
}
