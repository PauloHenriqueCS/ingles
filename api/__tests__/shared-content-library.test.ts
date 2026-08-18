/**
 * Shared content library (api/_shared-content/get-or-create-shared-content.ts).
 *
 * Exercises the REAL service against an in-memory client that faithfully models
 * the acquire_or_get_shared_content_item RPC (reuse-ready → reclaim-dead →
 * new-slot, with per-user NOT-EXISTS repetition avoidance), the two tables and
 * the audio Storage bucket. Covers: cache hit/miss, cross-user reuse + per-user
 * repetition avoidance, pedagogical compatibility, pronunciation text+audio
 * (valid reuse, incomplete-audio is not a complete hit, TTS-failure degrades to
 * text-only), writing shareability + isolation, failed-generation handling, and
 * usage-parity on hit and miss.
 */
import { describe, it, expect } from 'vitest';
import {
  getOrCreateSharedContent,
  type SharedContentIdentity,
  type SharedContentAudioSpec,
} from '../_shared-content/get-or-create-shared-content';

// ── Faithful in-memory Supabase client ───────────────────────────────────────
interface Item {
  id: string; modality: string; learning_language: string; interface_language: string;
  curriculum_version_id: string | null; subtopic_key: string; level_code: string;
  exercise_type: string; template_key: string; prompt_version: number; slot: number;
  status: string; content: unknown; error_message: string | null; lock_expires_at: string | null;
  generator_model: string | null; audio_status: string; audio_path: string | null;
  audio_mime_type: string | null; audio_voice: string | null; audio_locale: string | null;
  audio_lock_expires_at: string | null;
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function makeClient() {
  const items: Item[] = [];
  const usage: Array<{ user_id: string; shared_item_id: string; modality: string }> = [];
  const store = new Map<string, Buffer>();
  let idc = 0;

  function sameIdentity(i: Item, a: Record<string, any>): boolean {
    return (
      i.modality === a.p_modality &&
      i.learning_language === a.p_learning_language &&
      i.interface_language === a.p_interface_language &&
      (i.curriculum_version_id ?? null) === (a.p_curriculum_version_id ?? null) &&
      i.subtopic_key === a.p_subtopic_key &&
      i.level_code === a.p_level_code &&
      i.exercise_type === a.p_exercise_type &&
      i.template_key === a.p_template_key &&
      i.prompt_version === a.p_prompt_version
    );
  }
  const lockExpired = (i: Item) => !!i.lock_expires_at && i.lock_expires_at < new Date().toISOString();
  const future = () => new Date(Date.now() + 180_000).toISOString();
  const rowOut = (i: Item, won: boolean) => ({
    data: [{
      id: i.id, status: i.status, won, content: won ? null : i.content,
      audio_status: won ? 'none' : i.audio_status, audio_path: won ? null : i.audio_path,
      audio_mime_type: won ? null : i.audio_mime_type, audio_voice: won ? null : i.audio_voice,
      audio_locale: won ? null : i.audio_locale, error_message: won ? null : i.error_message,
    }],
    error: null,
  });

  const rpc = async (name: string, a: Record<string, any>) => {
    if (name !== 'acquire_or_get_shared_content_item') return { data: null, error: null };
    const matching = items.filter((i) => sameIdentity(i, a));
    const used = new Set(usage.filter((u) => u.user_id === a.p_user_id).map((u) => u.shared_item_id));
    const ready = matching.filter((i) => i.status === 'ready' && !used.has(i.id)).sort((x, y) => x.slot - y.slot)[0];
    if (ready) return rowOut(ready, false);
    const dead = matching
      .filter((i) => (i.status === 'failed' || (i.status === 'generating' && lockExpired(i))) && !used.has(i.id))
      .sort((x, y) => x.slot - y.slot)[0];
    if (dead) {
      dead.status = 'generating'; dead.lock_expires_at = future(); dead.error_message = null;
      return { data: [{ id: dead.id, status: 'generating', won: true, content: null, audio_status: 'none', audio_path: null, audio_mime_type: null, audio_voice: null, audio_locale: null, error_message: null }], error: null };
    }
    const nextSlot = matching.reduce((m, i) => Math.max(m, i.slot), 0) + 1;
    const item: Item = {
      id: `item-${++idc}`, modality: a.p_modality, learning_language: a.p_learning_language,
      interface_language: a.p_interface_language, curriculum_version_id: a.p_curriculum_version_id ?? null,
      subtopic_key: a.p_subtopic_key, level_code: a.p_level_code, exercise_type: a.p_exercise_type,
      template_key: a.p_template_key, prompt_version: a.p_prompt_version, slot: nextSlot,
      status: 'generating', content: null, error_message: null, lock_expires_at: future(),
      generator_model: null, audio_status: 'none', audio_path: null, audio_mime_type: null,
      audio_voice: null, audio_locale: null, audio_lock_expires_at: null,
    };
    items.push(item);
    return { data: [{ id: item.id, status: 'generating', won: true, content: null, audio_status: 'none', audio_path: null, audio_mime_type: null, audio_voice: null, audio_locale: null, error_message: null }], error: null };
  };

  function from(table: string) {
    const eqs: Array<[string, any]> = [];
    let inFilter: [string, any[]] | null = null;
    let orExpr: string | null = null;
    let op: 'select' | 'update' | 'upsert' | null = null;
    let payload: any = null;
    let onConflict: string | null = null;
    let ignoreDuplicates = false;
    let selectCols: string | null = null;
    let single = false;

    const rows = () => (table === 'shared_content_items' ? items : table === 'user_shared_content_usage' ? (usage as any[]) : []);
    const matchOr = (r: any): boolean => {
      if (!orExpr) return true;
      // Specific shape: "audio_status.in.(none,failed),audio_lock_expires_at.lt.<iso>"
      const inList = ['none', 'failed'];
      const m = /audio_lock_expires_at\.lt\.(.+)$/.exec(orExpr);
      const iso = m ? m[1] : null;
      return inList.includes(r.audio_status) || (iso != null && r.audio_lock_expires_at != null && r.audio_lock_expires_at < iso);
    };
    const matches = (r: any) =>
      eqs.every(([c, v]) => r[c] === v) &&
      (!inFilter || inFilter[1].includes(r[inFilter[0]])) &&
      matchOr(r);

    function execute() {
      if (op === 'update') {
        const hit = rows().filter(matches);
        for (const r of hit) Object.assign(r, payload);
        const data = selectCols ? (single ? hit[0] ?? null : hit.map((r) => ({ id: r.id }))) : null;
        return { data, error: null };
      }
      if (op === 'upsert') {
        const arr = rows();
        const conflictCols = (onConflict ?? '').split(',').map((c) => c.trim()).filter(Boolean);
        const exists = arr.find((r) => conflictCols.every((c) => r[c] === payload[c]));
        if (!exists) arr.push({ ...payload });
        else if (!ignoreDuplicates) Object.assign(exists, payload);
        return { data: null, error: null };
      }
      // select
      const hit = rows().filter(matches);
      return { data: single ? hit[0] ?? null : hit, error: null };
    }

    const q: any = {
      select(cols?: string) { if (op == null) op = 'select'; selectCols = cols ?? '*'; return q; },
      update(p: any) { op = 'update'; payload = p; return q; },
      upsert(p: any, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
        op = 'upsert'; payload = p; onConflict = opts?.onConflict ?? null; ignoreDuplicates = !!opts?.ignoreDuplicates; return q;
      },
      eq(c: string, v: any) { eqs.push([c, v]); return q; },
      in(c: string, v: any[]) { inFilter = [c, v]; return q; },
      or(expr: string) { orExpr = expr; return q; },
      maybeSingle() { single = true; return Promise.resolve(execute()); },
      then(resolve: (v: any) => any, reject?: (e: any) => any) { return Promise.resolve().then(execute).then(resolve, reject); },
    };
    return q;
  }

  const storage = {
    from(_bucket: string) {
      return {
        async upload(path: string, bytes: Buffer) { store.set(path, Buffer.from(bytes)); return { data: { path }, error: null }; },
        async download(path: string) {
          const b = store.get(path);
          if (!b) return { data: null, error: { message: 'not found' } };
          return { data: { arrayBuffer: async () => toArrayBuffer(b) }, error: null };
        },
      };
    },
  };

  return { rpc, from, storage, _items: items, _usage: usage, _store: store } as any;
}

const BASE: SharedContentIdentity = {
  modality: 'pronunciation', learningLanguage: 'en', interfaceLanguage: 'pt-BR',
  curriculumVersionId: 'v1-en', subtopicKey: 'A2.DAILY.ROUTINE', levelCode: 'A2',
  exerciseType: 'training', templateKey: 'pronunciation.generate_text', promptVersion: 1,
};

function audioSpec(onSynth: () => void, opts: { fail?: boolean } = {}): SharedContentAudioSpec<{ text: string }> {
  return {
    extractText: (c) => c.text,
    voice: 'en-US-AvaMultilingualNeural',
    locale: 'en-US',
    synth: async () => {
      onSynth();
      if (opts.fail) throw new Error('AZURE_TTS_HTTP_ERROR');
      return { audio: Buffer.from('AUDIO-BYTES'), mimeType: 'audio/mpeg' };
    },
  };
}

describe('shared content library — hit / miss / cross-user reuse', () => {
  it('MISS generates once; a DIFFERENT user REUSES it with no AI/TTS call', async () => {
    const client = makeClient();
    let gen = 0, syn = 0;
    const call = (userId: string) => getOrCreateSharedContent<{ text: string }>({
      client, userId, identity: BASE, generatorModel: 'gpt-4o-mini',
      generateContent: async () => { gen++; return { text: 'Read this aloud.' }; },
      audio: audioSpec(() => { syn++; }),
    });

    const a = await call('userA');
    expect(a.reused).toBe(false);
    expect(gen).toBe(1); expect(syn).toBe(1);
    expect(a.audio?.base64).toBe(Buffer.from('AUDIO-BYTES').toString('base64'));

    const b = await call('userB');
    expect(b.reused).toBe(true);          // cache hit
    expect(gen).toBe(1);                   // OpenAI NOT called again
    expect(syn).toBe(1);                   // TTS NOT called again (audio already valid)
    expect(b.content.text).toBe('Read this aloud.');
    expect(b.audio?.base64).toBe(a.audio?.base64);
    expect(b.itemId).toBe(a.itemId);
  });

  it('per-user repetition avoidance: the same user does NOT get the same item twice', async () => {
    const client = makeClient();
    let gen = 0;
    const call = () => getOrCreateSharedContent<{ text: string }>({
      client, userId: 'userA', identity: BASE,
      generateContent: async () => { gen++; return { text: `text ${gen}` }; },
    });
    const first = await call();
    const second = await call();
    expect(gen).toBe(2);                       // a new item was generated for the same user
    expect(second.itemId).not.toBe(first.itemId);
  });

  it('cache HIT still records per-user usage (activity parity with a miss)', async () => {
    const client = makeClient();
    const call = (userId: string) => getOrCreateSharedContent<{ text: string }>({
      client, userId, identity: BASE,
      generateContent: async () => ({ text: 'hello' }),
      audio: audioSpec(() => {}),
    });
    await call('userA'); // miss
    await call('userB'); // hit
    expect(client._usage.filter((u: any) => u.user_id === 'userA')).toHaveLength(1);
    expect(client._usage.filter((u: any) => u.user_id === 'userB')).toHaveLength(1);
  });
});

describe('shared content library — pedagogical compatibility', () => {
  const variants: Array<[string, Partial<SharedContentIdentity>]> = [
    ['other learning_language', { learningLanguage: 'es' }],
    ['other level', { subtopicKey: 'B1.OPINION.AGREE', levelCode: 'B1' }],
    ['other curriculum version', { curriculumVersionId: 'v2-en' }],
    ['other prompt version', { promptVersion: 2 }],
    ['other interface language', { interfaceLanguage: 'en-US' }],
  ];
  for (const [label, override] of variants) {
    it(`does NOT reuse content of ${label}`, async () => {
      const client = makeClient();
      let gen = 0;
      await getOrCreateSharedContent<{ text: string }>({
        client, userId: 'seed', identity: BASE,
        generateContent: async () => { gen++; return { text: 'base' }; },
      });
      expect(gen).toBe(1);
      // A different user asks for an INCOMPATIBLE identity → must generate fresh.
      const res = await getOrCreateSharedContent<{ text: string }>({
        client, userId: 'other', identity: { ...BASE, ...override },
        generateContent: async () => { gen++; return { text: 'variant' }; },
      });
      expect(res.reused).toBe(false);
      expect(gen).toBe(2);
      expect(res.content.text).toBe('variant');
    });
  }
});

describe('shared content library — pronunciation audio (§9)', () => {
  it('a text-ready item WITHOUT valid audio is not a complete hit: audio is (re)generated on demand', async () => {
    const client = makeClient();
    // Seed a ready TEXT item whose audio previously FAILED (no audio_path).
    client._items.push({
      id: 'seed-1', modality: 'pronunciation', learning_language: 'en', interface_language: 'pt-BR',
      curriculum_version_id: 'v1-en', subtopic_key: 'A2.DAILY.ROUTINE', level_code: 'A2',
      exercise_type: 'training', template_key: 'pronunciation.generate_text', prompt_version: 1, slot: 1,
      status: 'ready', content: { text: 'seeded text' }, error_message: null, lock_expires_at: null,
      generator_model: 'gpt-4o-mini', audio_status: 'failed', audio_path: null, audio_mime_type: null,
      audio_voice: null, audio_locale: null, audio_lock_expires_at: null,
    });
    let gen = 0, syn = 0;
    const res = await getOrCreateSharedContent<{ text: string }>({
      client, userId: 'userX', identity: BASE,
      generateContent: async () => { gen++; return { text: 'unused' }; },
      audio: audioSpec(() => { syn++; }),
    });
    expect(res.reused).toBe(true);   // text is a valid hit
    expect(gen).toBe(0);             // no OpenAI call — text reused
    expect(syn).toBe(1);             // but TTS WAS called to complete the missing audio
    expect(res.audio?.base64).toBe(Buffer.from('AUDIO-BYTES').toString('base64'));
    expect(client._items[0].audio_status).toBe('ready');
    expect(client._items[0].audio_path).toBe('pronunciation/seed-1.mp3');
  });

  it('TTS failure degrades to text-only (never a broken audio pointer)', async () => {
    const client = makeClient();
    let gen = 0, syn = 0;
    const res = await getOrCreateSharedContent<{ text: string }>({
      client, userId: 'userY', identity: BASE,
      generateContent: async () => { gen++; return { text: 'the text' }; },
      audio: audioSpec(() => { syn++; }, { fail: true }),
    });
    expect(gen).toBe(1);
    expect(syn).toBe(1);
    expect(res.content.text).toBe('the text'); // text still served
    expect(res.audio).toBeNull();              // no audio, and NOT a broken pointer
    expect(client._items[0].audio_status).toBe('failed');
    expect(client._items[0].audio_path).toBeNull();
  });
});

describe('shared content library — writing shareability & isolation', () => {
  const WRITING: SharedContentIdentity = {
    modality: 'writing', learningLanguage: 'en', interfaceLanguage: 'pt-BR',
    curriculumVersionId: 'v1-en', subtopicKey: 'B1.OPINION.AGREE', levelCode: 'B1',
    exerciseType: 'mission', templateKey: 'writing.generate_topic', promptVersion: 1,
  };
  it('a mission is shareable across users; no audio; only the shared tables are touched', async () => {
    const client = makeClient();
    let gen = 0;
    const mission = { title: 'Give your opinion', mission: 'Write a short opinion.' };
    const call = (userId: string) => getOrCreateSharedContent<typeof mission>({
      client, userId, identity: WRITING,
      generateContent: async () => { gen++; return mission; },
    });
    const a = await call('userA');
    const b = await call('userB');
    expect(gen).toBe(1);                 // generated once, reused across users
    expect(b.reused).toBe(true);
    expect(a.audio).toBeNull();
    expect(b.audio).toBeNull();
    expect(b.content).toEqual(mission);  // same shared base content
    // No per-user response/correction table exists in the shared library at all.
    expect(client._store.size).toBe(0); // writing produced no audio objects
  });
});

describe('shared content library — failed generation', () => {
  it('a failed generation is marked failed (never a valid hit) and is reclaimable', async () => {
    const client = makeClient();
    // First attempt: generator throws → item marked failed, error re-thrown.
    await expect(getOrCreateSharedContent<{ text: string }>({
      client, userId: 'userA', identity: BASE,
      generateContent: async () => { throw new Error('boom'); },
    })).rejects.toThrow('boom');
    expect(client._items[0].status).toBe('failed');

    // Retry: reclaims the dead slot and succeeds — no orphan/second identity row.
    const res = await getOrCreateSharedContent<{ text: string }>({
      client, userId: 'userA', identity: BASE,
      generateContent: async () => ({ text: 'recovered' }),
    });
    expect(res.content.text).toBe('recovered');
    expect(client._items).toHaveLength(1);      // same row reclaimed, not a new one
    expect(client._items[0].status).toBe('ready');
  });
});
