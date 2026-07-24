import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const email = 'paulo.henrique1042@gmail.com';

async function freshToken() {
  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (linkErr) throw linkErr;
  const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: verifyData, error: verifyErr } = await anon.auth.verifyOtp({
    email, token: linkData.properties.email_otp, type: 'email',
  });
  if (verifyErr) throw verifyErr;
  return { accessToken: verifyData.session.access_token, userId: verifyData.user.id };
}

const REVIEW_ID = 'b69f8402-7ef5-4072-babf-695ebad9d9e2';
const { accessToken } = await freshToken();

async function callEvaluate(rewriteText) {
  const res = await fetch('https://my.lemonenglish.app/api/writing-rewrite-evaluate', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewId: REVIEW_ID, rewriteText }),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

console.log('=== 1) Exact reported bug input: "5eysvduduud" ===');
const r1 = await callEvaluate('5eysvduduud');
console.log('status', r1.status, JSON.stringify(r1.body).slice(0, 300));

console.log('\n=== 2) Multi-token gibberish: "xkcd qzwe mnbv zxqw" ===');
const r2 = await callEvaluate('xkcd qzwe mnbv zxqw');
console.log('status', r2.status, JSON.stringify(r2.body).slice(0, 300));

console.log('\n=== 3) Empty string ===');
const r3 = await callEvaluate('');
console.log('status', r3.status, JSON.stringify(r3.body).slice(0, 300));

console.log('\n=== 4) Valid legitimate text (should succeed end-to-end) ===');
const validText = `Yesterday I went to the store and bought some bread and fruits, run ${Date.now()}.`;
const r4 = await callEvaluate(validText);
console.log('status', r4.status, JSON.stringify(r4.body).slice(0, 300));

console.log('\n=== 5) Retry with SAME valid text (idempotency: must reuse, not duplicate) ===');
const r5 = await callEvaluate(validText);
console.log('status', r5.status, JSON.stringify(r5.body).slice(0, 300));
console.log('same rewriteSubmissionId as (4)?', r4.body?.result?.rewriteSubmissionId === r5.body?.result?.rewriteSubmissionId);
