/**
 * Safe {{placeholder}} template engine.
 *
 * - NO eval, NO Function(), NO stored executable code. Pure string interpolation.
 * - Placeholders match {{ name }} where name is [a-zA-Z0-9_.]+.
 * - A placeholder present in the template but missing from the value map throws
 *   MissingPlaceholderError (explicit + observable). There is NO silent fallback
 *   to any hardcoded pedagogical text — a misconfigured template is an
 *   operational error, by design.
 */

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export class MissingPlaceholderError extends Error {
  constructor(public readonly placeholder: string) {
    super(`Template placeholder "${placeholder}" has no value`);
    this.name = 'MissingPlaceholderError';
  }
}

export class TemplateValidationError extends Error {
  constructor(message: string, public readonly missing: string[]) {
    super(message);
    this.name = 'TemplateValidationError';
  }
}

/** Returns the unique placeholder names referenced by a template body. */
export function extractPlaceholders(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    found.add(match[1]);
  }
  return [...found];
}

/**
 * Validates that every declared-required placeholder actually appears in the
 * template body. Used at seed/publish time and in tests.
 */
export function validateTemplateRequires(template: string, required: readonly string[]): void {
  const present = new Set(extractPlaceholders(template));
  const missing = required.filter((r) => !present.has(r));
  if (missing.length > 0) {
    throw new TemplateValidationError(
      `Template is missing required placeholders: ${missing.join(', ')}`,
      missing,
    );
  }
}

export interface RenderOptions {
  /** When false (default) an unresolved placeholder throws. */
  allowMissing?: boolean;
}

/**
 * Interpolates a template body with the given values. Throws
 * MissingPlaceholderError on any unresolved placeholder unless allowMissing.
 */
export function renderTemplate(
  template: string,
  values: Readonly<Record<string, string | number | null | undefined>>,
  options: RenderOptions = {},
): string {
  return template.replace(PLACEHOLDER_RE, (_full, name: string) => {
    const value = values[name];
    // Only a genuinely-missing key (not in the value map) hard-fails. An empty
    // string is a provided-but-empty optional value and renders as empty.
    if (value === undefined || value === null) {
      if (options.allowMissing) return '';
      throw new MissingPlaceholderError(name);
    }
    return String(value);
  });
}
