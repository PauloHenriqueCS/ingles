import { describe, it, expect, vi } from 'vitest';
import { getLanguageNamesMap, getLanguageNames } from '../_curriculum/language-names';

function clientReturning(rows: any[] | null, opts: { throws?: boolean } = {}) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        in: vi.fn(() => {
          if (opts.throws) throw new Error('db down');
          return Promise.resolve({ data: rows, error: null });
        }),
      })),
    })),
  } as any;
}

describe('getLanguageNamesMap', () => {
  it('resolves english_name and native_name for known codes', async () => {
    const client = clientReturning([
      { code: 'en', english_name: 'English', native_name: 'English' },
      { code: 'pt-BR', english_name: 'Brazilian Portuguese', native_name: 'Português (Brasil)' },
    ]);
    const map = await getLanguageNamesMap(client, ['en', 'pt-BR']);
    expect(map.get('en')).toEqual({ englishName: 'English', nativeName: 'English' });
    expect(map.get('pt-BR')).toEqual({ englishName: 'Brazilian Portuguese', nativeName: 'Português (Brasil)' });
  });

  it('falls back to the raw code for a code with no row', async () => {
    const client = clientReturning([{ code: 'en', english_name: 'English', native_name: 'English' }]);
    const map = await getLanguageNamesMap(client, ['en', 'xx']);
    expect(map.get('xx')).toEqual({ englishName: 'xx', nativeName: 'xx' });
  });

  it('never throws on a read error — degrades to raw codes', async () => {
    const client = clientReturning(null, { throws: true });
    const map = await getLanguageNamesMap(client, ['en', 'es']);
    expect(map.get('en')).toEqual({ englishName: 'en', nativeName: 'en' });
    expect(map.get('es')).toEqual({ englishName: 'es', nativeName: 'es' });
  });

  it('getLanguageNames returns the single resolved entry', async () => {
    const client = clientReturning([{ code: 'es', english_name: 'Spanish', native_name: 'Español' }]);
    expect(await getLanguageNames(client, 'es')).toEqual({ englishName: 'Spanish', nativeName: 'Español' });
  });
});
