export class ListeningSsmlStructureError extends Error {
  readonly code = 'SSML_STRUCTURE_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'ListeningSsmlStructureError';
  }
}

export function validateListeningSsmlStructure(ssml: string, blockOrder: 1 | 2): void {
  if (!ssml.trimStart().startsWith('<speak')) {
    throw new ListeningSsmlStructureError('SSML must start with <speak>');
  }
  if (!ssml.trimEnd().endsWith('</speak>')) {
    throw new ListeningSsmlStructureError('SSML must end with </speak>');
  }
  if (!ssml.includes('<voice')) {
    throw new ListeningSsmlStructureError('SSML must contain a <voice> element');
  }
  if (!ssml.includes('</voice>')) {
    throw new ListeningSsmlStructureError('SSML must contain a closing </voice> tag');
  }
  if (!ssml.includes(`<bookmark mark="block-${blockOrder}-start"/>`)) {
    throw new ListeningSsmlStructureError(`SSML must contain block-${blockOrder}-start bookmark`);
  }
  if (!ssml.includes(`<bookmark mark="block-${blockOrder}-end"/>`)) {
    throw new ListeningSsmlStructureError(`SSML must contain block-${blockOrder}-end bookmark`);
  }
}
