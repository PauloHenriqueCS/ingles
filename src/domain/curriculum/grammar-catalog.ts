import { GrammarTopic } from './grammar-types';
import { A1_TOPICS } from './topics/a1';
import { A2_TOPICS } from './topics/a2';
import { B1_TOPICS } from './topics/b1';
import { B2_TOPICS } from './topics/b2';
import { C1_TOPICS } from './topics/c1';
import { C2_TOPICS } from './topics/c2';

const ALL_TOPICS_MUTABLE: GrammarTopic[] = [
  ...A1_TOPICS,
  ...A2_TOPICS,
  ...B1_TOPICS,
  ...B2_TOPICS,
  ...C1_TOPICS,
  ...C2_TOPICS,
];

export const GRAMMAR_CATALOG: readonly GrammarTopic[] = Object.freeze(ALL_TOPICS_MUTABLE);

export const CATALOG_VERSION = 1;
