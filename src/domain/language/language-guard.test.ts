import { describe, it, expect } from 'vitest';
import { evaluateOutputLanguage, tokenizeWords } from './language-guard';

// The reported bug: student wrote English, the "Versão final corrigida" came back
// with Portuguese sentences mixed in.
const ENGLISH_CORRECTION =
  'Hello! My name is Paulo. I am from São Paulo, Brazil. What is your name? I would like to know more about you and where you are from.';
const HYBRID_PT_EN =
  'Hello! My name is Paulo. Eu sou de São Paulo, Brasil. Qual é o seu nome? Eu gostaria de saber mais sobre você.';
const PORTUGUESE_STORY =
  'Era uma vez, em uma pequena cidade, um menino chamado Lucas. Ele estava no parque quando viu uma menina que brincava sozinha. Lucas disse que queria ser amigo dela.';

describe('evaluateOutputLanguage — English learning language', () => {
  it('accepts a fully-English corrected text', () => {
    const r = evaluateOutputLanguage(ENGLISH_CORRECTION, 'en');
    expect(r.ok).toBe(true);
  });

  it('rejects a corrected text that mixes Portuguese into English', () => {
    const r = evaluateOutputLanguage(HYBRID_PT_EN, 'en');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/mixed_language|wrong_language/);
  });

  it('rejects a story that came out entirely in Portuguese (the Listening bug)', () => {
    const r = evaluateOutputLanguage(PORTUGUESE_STORY, 'en');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('wrong_language');
    expect(r.detected).toBe('pt-BR');
  });
});

describe('evaluateOutputLanguage — multilingual / configurable (no English-specific logic)', () => {
  it('accepts a fully-Portuguese story when the learning language IS Portuguese', () => {
    const r = evaluateOutputLanguage(PORTUGUESE_STORY, 'pt-BR');
    expect(r.ok).toBe(true);
  });

  it('a Spanish learner: rejects English output when learning Spanish', () => {
    const r = evaluateOutputLanguage(ENGLISH_CORRECTION, 'es');
    expect(r.ok).toBe(false);
    expect(r.detected).toBe('en');
  });

  it('a Spanish learner: accepts Spanish output', () => {
    const spanish =
      '¡Hola! Me llamo Paula. Yo soy de Madrid, pero ahora vivo en otra ciudad con mi familia. ¿Cómo te llamas tú? Me gustaría saber más sobre ti.';
    const r = evaluateOutputLanguage(spanish, 'es');
    expect(r.ok).toBe(true);
  });
});

describe('evaluateOutputLanguage — conservative (never false-positives)', () => {
  it('does not judge a too-short text', () => {
    const r = evaluateOutputLanguage('Hello there friend.', 'en');
    expect(r.ok).toBe(true);
    expect(r.detected).toBeNull();
  });

  it('degrades to ok for a learning language it has no profile for', () => {
    const r = evaluateOutputLanguage(PORTUGUESE_STORY, 'xx-unknown');
    expect(r.ok).toBe(true);
  });

  it('a few proper nouns / borrowed words do not trip the guard', () => {
    const englishWithNames =
      'On Monday, Ana and João visited the São Paulo museum with their friends and they had a wonderful time together looking at the art.';
    const r = evaluateOutputLanguage(englishWithNames, 'en');
    expect(r.ok).toBe(true);
  });
});

describe('tokenizeWords', () => {
  it('normalises typographic apostrophes and lowercases', () => {
    expect(tokenizeWords("Don’t STOP it's fine")).toEqual(["don't", 'stop', "it's", 'fine']);
  });
});
