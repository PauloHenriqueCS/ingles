import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

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

async function getEntitlements(token) {
  const res = await fetch('https://my.lemonenglish.app/api/pronunciation-training/plan-entitlements', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  return { status: res.status, body };
}

async function callReview(token, attemptId) {
  const res = await fetch('https://my.lemonenglish.app/api/review-text', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      originalText: 'Yesterday I go to the market and I buyed some fruits and vegetable.',
      theme: 'A trip to the market',
      grammarGoal: 'Past Simple',
      mainTense: 'Past Simple',
      attemptId,
    }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

const { accessToken, userId } = await freshToken();
console.log('=== userId ===', userId);

console.log('\n=== 1) entitlements BEFORE ===');
const before = await getEntitlements(accessToken);
console.log(JSON.stringify(before, null, 2));

const attemptId = crypto.randomUUID();
console.log('\n=== 2) real review call (attemptId =', attemptId, ') ===');
const first = await callReview(accessToken, attemptId);
console.log('status', first.status);
console.log(JSON.stringify(first.body, null, 2));

console.log('\n=== 3) entitlements AFTER first call ===');
const after = await getEntitlements(accessToken);
console.log(JSON.stringify(after, null, 2));

console.log('\n=== 4) RETRY same attemptId (must not call AI again) ===');
const retry = await callReview(accessToken, attemptId);
console.log('status', retry.status);
console.log(JSON.stringify(retry.body, null, 2));

console.log('\n=== 5) entitlements AFTER retry (must be unchanged from step 3) ===');
const afterRetry = await getEntitlements(accessToken);
console.log(JSON.stringify(afterRetry, null, 2));
