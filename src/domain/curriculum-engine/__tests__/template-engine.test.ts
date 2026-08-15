import { describe, it, expect } from 'vitest';
import {
  extractPlaceholders,
  renderTemplate,
  validateTemplateRequires,
  MissingPlaceholderError,
  TemplateValidationError,
} from '../template-engine';

describe('template-engine', () => {
  it('extracts unique placeholders', () => {
    const t = 'Hi {{name}}, level {{ level }} for {{name}}';
    expect(extractPlaceholders(t).sort()).toEqual(['level', 'name']);
  });

  it('renders provided values', () => {
    expect(renderTemplate('{{a}}-{{b}}', { a: 'x', b: 2 })).toBe('x-2');
  });

  it('renders empty string for provided-but-empty optional values', () => {
    expect(renderTemplate('[{{opt}}]', { opt: '' })).toBe('[]');
  });

  it('throws on a genuinely missing placeholder (no silent fallback)', () => {
    expect(() => renderTemplate('{{missing}}', {})).toThrow(MissingPlaceholderError);
  });

  it('allows missing when opted in', () => {
    expect(renderTemplate('{{missing}}', {}, { allowMissing: true })).toBe('');
  });

  it('validates required placeholders exist in the body', () => {
    expect(() => validateTemplateRequires('{{a}}', ['a', 'b'])).toThrow(TemplateValidationError);
    expect(() => validateTemplateRequires('{{a}} {{b}}', ['a', 'b'])).not.toThrow();
  });

  it('does not evaluate code — braces without valid names are literal', () => {
    expect(renderTemplate('{{ not valid }} {}{}', {})).toBe('{{ not valid }} {}{}');
  });
});
