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

const REVIEW_ID = 'b69f8402-7ef5-4072-babf-695ebad9d9e2'; // real existing review, has corrected_text
const GARBAGE = '5eysvduduud';

const { accessToken } = await freshToken();

console.log('=== 1) POST /api/writing-rewrite-evaluate (garbage rewriteText) ===');
const t0 = Date.now();
const evalRes = await fetch('https://my.lemonenglish.app/api/writing-rewrite-evaluate', {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ reviewId: REVIEW_ID, rewriteText: GARBAGE }),
});
const evalBody = await evalRes.text();
console.log('status', evalRes.status, 'elapsed_ms', Date.now() - t0);
console.log(evalBody);

console.log('\n=== 2) POST /api/compare-rewrite (generateFinalTextOnly, garbage rewriteText) ===');
// Fetch the review's real correctedText server-side isn't available to this
// script, so pull it via service role for the prompt input, matching what
// the frontend already has in aiReview.correctedText.
const admin = createClient(url, serviceKey);
const { data: reviewRow } = await admin.from('english_reviews').select('corrected_text').eq('id', REVIEW_ID).single();

const t1 = Date.now();
const finalRes = await fetch('https://my.lemonenglish.app/api/compare-rewrite', {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ generateFinalTextOnly: true, correctedText: reviewRow.corrected_text, rewriteText: GARBAGE }),
});
const finalBody = await finalRes.text();
console.log('status', finalRes.status, 'elapsed_ms', Date.now() - t1);
console.log(finalBody);
