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
const VALID_TEXT = 'Yesterday I went to the store and bought some bread and fruits.';

const { accessToken } = await freshToken();

console.log('=== POST /api/writing-rewrite-evaluate (VALID text, still-old-deployed code, post-migration) ===');
const t0 = Date.now();
const res = await fetch('https://my.lemonenglish.app/api/writing-rewrite-evaluate', {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ reviewId: REVIEW_ID, rewriteText: VALID_TEXT }),
});
const body = await res.text();
console.log('status', res.status, 'elapsed_ms', Date.now() - t0);
console.log(body.slice(0, 500));
