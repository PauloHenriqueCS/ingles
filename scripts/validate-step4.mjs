/**
 * Step 4 validation script — run once, then delete.
 * Does NOT send audio, does NOT trigger actual pronunciation analysis.
 * Does NOT log tokens or permanent keys.
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://jiuurvheeuwmayrfnqgm.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_WJhcy6w-aryOlo_ILBaGog_BljxCu4R';
const API_BASE = 'https://ingles-3ykwonksr-paulohenriquecs-projects.vercel.app';

const TEST_EMAIL = `lemon.probe.${Date.now()}@test.invalid`;
const TEST_PASSWORD = `Probe!${Date.now()}`;

const pass = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg, detail = '') => { console.error(`  ✗ ${msg}`, detail); process.exitCode = 1; };
const note = (msg) => console.log(`  · ${msg}`);

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── 1. Create throwaway test user ─────────────────────────────────────────────
console.log('\n[1] Criando usuário de teste...');
const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
  email: TEST_EMAIL,
  password: TEST_PASSWORD,
});

if (signUpError || !signUpData.session) {
  fail('Signup falhou — verificação de email pode estar ativada no Supabase.', signUpError?.message ?? 'no session');
  console.log('\nPara continuar: desative "Email Confirmation" no Supabase > Auth > Settings e rode novamente.');
  process.exit(1);
}

const session = signUpData.session;
const userId = signUpData.user.id;
note(`userId: ${userId}`);
pass('Usuário criado e sessão obtida');

const authHeader = { Authorization: `Bearer ${session.access_token}` };
const authedSupabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { headers: authHeader },
});

// ── 2. Create test english_review with corrected_text ────────────────────────
console.log('\n[2] Criando english_review de teste...');
const { data: review, error: reviewError } = await authedSupabase
  .from('english_reviews')
  .insert({
    user_id: userId,
    original_text: 'This is a test original text for step 4 validation.',
    corrected_text: 'This is a test corrected text for pronunciation validation.',
    score: 75,
    level: 'B1',
    grammar: 70,
    vocabulary: 75,
    naturalness: 80,
    fluency: 75,
    main_mistakes: [],
    new_vocabulary: [],
  })
  .select('id, corrected_text, version_2_text')
  .single();

if (reviewError || !review) {
  fail('Falha ao criar english_review', reviewError?.message);
  process.exit(1);
}

const textVersionId = review.id;
note(`textVersionId: ${textVersionId}`);
note(`corrected_text: "${review.corrected_text}"`);
note(`version_2_text: ${review.version_2_text ?? 'null'}`);
pass('english_review criado');

// ── 3. Call POST /api/pronunciation/start (first time) ───────────────────────
console.log('\n[3] Chamando POST /api/pronunciation/start (primeira chamada)...');
const startRes = await fetch(`${API_BASE}/api/pronunciation/start`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...authHeader },
  body: JSON.stringify({ textVersionId }),
});

const startBody = await startRes.json();

// 3a. HTTP status
if (startRes.status === 200) {
  pass(`HTTP 200 OK`);
} else {
  fail(`HTTP status inesperado: ${startRes.status}`, JSON.stringify(startBody));
  process.exitCode = 1;
}

// 3b. assessmentId
if (startBody.assessmentId && typeof startBody.assessmentId === 'string') {
  pass(`assessmentId presente: ${startBody.assessmentId}`);
} else {
  fail('assessmentId ausente ou inválido', JSON.stringify(startBody));
}
const assessmentId = startBody.assessmentId;

// 3c. Token (check presence but never log full value)
if (startBody.token && typeof startBody.token === 'string' && startBody.token.length > 20) {
  pass(`token presente (comprimento: ${startBody.token.length} chars, início: ${startBody.token.slice(0, 6)}...)`);
} else {
  fail('token ausente ou muito curto', `length=${startBody.token?.length}`);
}

// 3d. Region
if (startBody.region && typeof startBody.region === 'string') {
  pass(`region: "${startBody.region}"`);
} else {
  fail('region ausente', JSON.stringify(startBody));
}

// 3e. Language
if (startBody.language === 'en-US') {
  pass('language = en-US');
} else {
  fail(`language incorreto: "${startBody.language}"`);
}

// 3f. referenceText from DB (corrected_text since version_2_text is null)
const expectedRef = review.corrected_text;
if (startBody.referenceText === expectedRef) {
  pass(`referenceText corresponde ao corrected_text do banco`);
} else if (startBody.referenceText) {
  note(`referenceText recebido: "${startBody.referenceText}"`);
  note(`expected: "${expectedRef}"`);
  fail('referenceText não corresponde ao valor do banco');
} else {
  fail('referenceText ausente');
}

// 3g. Cache-Control: no-store
const cacheControl = startRes.headers.get('cache-control') ?? '';
if (cacheControl.includes('no-store')) {
  pass(`Cache-Control: ${cacheControl}`);
} else {
  fail(`Cache-Control incorreto ou ausente: "${cacheControl}"`);
}

// 3h. Permanent key not in response
const responseText = JSON.stringify(startBody);
if (!responseText.includes('AZURE_SPEECH_KEY') && !responseText.toUpperCase().includes('SUBSCRIPTION-KEY')) {
  pass('Resposta não contém chave permanente');
} else {
  fail('Resposta pode conter referência à chave permanente');
}

// ── 4. Verify DB row via Supabase ─────────────────────────────────────────────
console.log('\n[4] Verificando linha em pronunciation_assessments...');
const { data: rows, error: rowsError } = await authedSupabase
  .from('pronunciation_assessments')
  .select('*')
  .eq('text_version_id', textVersionId)
  .eq('user_id', userId);

if (rowsError) {
  fail('Falha ao consultar pronunciation_assessments', rowsError.message);
} else {
  // 4a. Exactly one row
  if (rows.length === 1) {
    pass('Exatamente 1 linha criada em pronunciation_assessments');
  } else {
    fail(`Número incorreto de linhas: ${rows.length}`);
  }

  const row = rows[0];
  if (row) {
    // 4b. status = processing
    if (row.status === 'processing') {
      pass(`status = processing`);
    } else {
      fail(`status inesperado: "${row.status}"`);
    }

    // 4c. reference_text matches
    if (row.reference_text === expectedRef) {
      pass('reference_text salvo corretamente no banco');
    } else {
      fail(`reference_text no banco não corresponde`, `"${row.reference_text}" vs "${expectedRef}"`);
    }

    // 4d. language_code
    if (row.language_code === 'en-US') {
      pass(`language_code = en-US no banco`);
    } else {
      fail(`language_code incorreto: "${row.language_code}"`);
    }

    // 4e. user_id correct
    if (row.user_id === userId) {
      pass('user_id correto no banco');
    } else {
      fail('user_id incorreto no banco');
    }

    // 4f. Azure key not in stored data
    const rowText = JSON.stringify(row);
    if (!rowText.includes('AZURE_SPEECH_KEY')) {
      pass('Linha do banco não contém chave permanente');
    } else {
      fail('Linha do banco pode conter referência à chave');
    }
  }
}

// ── 5. Second call — same textVersionId (idempotência) ───────────────────────
console.log('\n[5] Segunda chamada com o mesmo textVersionId (idempotência)...');
const start2Res = await fetch(`${API_BASE}/api/pronunciation/start`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...authHeader },
  body: JSON.stringify({ textVersionId }),
});

const start2Body = await start2Res.json();

if (start2Res.status === 200) {
  pass('Segunda chamada retornou 200');
} else {
  fail(`Segunda chamada retornou ${start2Res.status}`, JSON.stringify(start2Body));
}

if (start2Body.assessmentId === assessmentId) {
  pass(`Mesmo assessmentId retornado: ${assessmentId}`);
} else {
  fail(`assessmentId diferente na segunda chamada: ${start2Body.assessmentId}`);
}

// 5c. Still only one row in DB
const { data: rows2 } = await authedSupabase
  .from('pronunciation_assessments')
  .select('id')
  .eq('text_version_id', textVersionId)
  .eq('user_id', userId);

if (rows2?.length === 1) {
  pass('Ainda apenas 1 linha no banco após segunda chamada');
} else {
  fail(`Número de linhas após segunda chamada: ${rows2?.length}`);
}

// ── 6. Test payload rejection ─────────────────────────────────────────────────
console.log('\n[6] Validando rejeições de payload...');

const badUuidRes = await fetch(`${API_BASE}/api/pronunciation/start`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...authHeader },
  body: JSON.stringify({ textVersionId: 'not-a-uuid' }),
});
if (badUuidRes.status === 400) {
  pass('UUID inválido → 400');
} else {
  fail(`UUID inválido deveria ser 400, got ${badUuidRes.status}`);
}

const noAuthRes = await fetch(`${API_BASE}/api/pronunciation/start`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ textVersionId }),
});
if (noAuthRes.status === 401) {
  pass('Sem auth → 401');
} else {
  fail(`Sem auth deveria ser 401, got ${noAuthRes.status}`);
}

const otherUserUuid = '00000000-0000-0000-0000-000000000001';
const notFoundRes = await fetch(`${API_BASE}/api/pronunciation/start`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...authHeader },
  body: JSON.stringify({ textVersionId: otherUserUuid }),
});
if (notFoundRes.status === 404) {
  pass('textVersionId inexistente → 404');
} else {
  fail(`textVersionId inexistente deveria ser 404, got ${notFoundRes.status}`);
}

// ── 7. Cleanup ────────────────────────────────────────────────────────────────
console.log('\n[7] Limpeza (assessment de teste criado pelo fluxo)...');
note('A linha em pronunciation_assessments e o english_review de teste permanecerão no banco.');
note('Para limpar: DELETE FROM pronunciation_assessments WHERE id = \'' + assessmentId + '\';');
note('             DELETE FROM english_reviews WHERE id = \'' + textVersionId + '\';');
note('             DELETE FROM auth.users WHERE id = \'' + userId + '\';');

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n════════════════════════════════════════');
if (process.exitCode === 1) {
  console.log('RESULTADO: algumas verificações falharam — veja ✗ acima');
} else {
  console.log('RESULTADO: todas as verificações passaram ✓');
}
console.log('════════════════════════════════════════');
