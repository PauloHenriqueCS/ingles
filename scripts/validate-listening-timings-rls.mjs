import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

// Two of the account holder's own real accounts (confirmed distinct users in
// auth.users) — used instead of unrelated third-party accounts to avoid
// impersonating anyone else's session, even briefly/read-only.
const USER_A_EMAIL = 'paulo.henrique1042@gmail.com';
const USER_B_EMAIL = 'paulo.hc@outlook.com';

async function tokenFor(email) {
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

async function restSelect(token, table) {
  const headers = { apikey: anonKey };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, { headers });
  const body = await res.text();
  return { status: res.status, body };
}

async function restInsert(token, table, row) {
  const headers = { apikey: anonKey, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${url}/rest/v1/${table}`, { method: 'POST', headers, body: JSON.stringify(row) });
  const body = await res.text();
  return { status: res.status, body };
}

const FAKE_ROWS = {
  listening_bookmark_timings: { audio_asset_id: '00000000-0000-0000-0000-000000000000', bookmark_name: 'x', event_order: 1, offset_ms: 0, raw_offset_ticks: 0 },
  listening_word_timings: { audio_asset_id: '00000000-0000-0000-0000-000000000000', word_order: 1, text: 'x', start_ms: 0 },
};
const TABLES = Object.keys(FAKE_ROWS);

console.log('=== anon key (no auth header) — real PostgREST call ===');
for (const t of TABLES) {
  const sel = await restSelect(null, t);
  console.log(`anon SELECT ${t}: status=${sel.status} body=${sel.body.slice(0, 150)}`);
  const ins = await restInsert(null, t, FAKE_ROWS[t]);
  console.log(`anon INSERT ${t}: status=${ins.status} body=${ins.body.slice(0, 150)}`);
}

console.log('\n=== USER A (paulo.henrique1042@gmail.com) — real authenticated session ===');
const userA = await tokenFor(USER_A_EMAIL);
console.log('userA id:', userA.userId);
for (const t of TABLES) {
  const sel = await restSelect(userA.accessToken, t);
  console.log(`userA SELECT ${t}: status=${sel.status} body=${sel.body.slice(0, 150)}`);
  const ins = await restInsert(userA.accessToken, t, FAKE_ROWS[t]);
  console.log(`userA INSERT ${t}: status=${ins.status} body=${ins.body.slice(0, 150)}`);
}

console.log('\n=== USER B (paulo.hc@outlook.com) — real, DISTINCT authenticated session ===');
const userB = await tokenFor(USER_B_EMAIL);
console.log('userB id:', userB.userId, '(distinct from userA?', userB.userId !== userA.userId, ')');
for (const t of TABLES) {
  const sel = await restSelect(userB.accessToken, t);
  console.log(`userB SELECT ${t}: status=${sel.status} body=${sel.body.slice(0, 150)}`);
  const ins = await restInsert(userB.accessToken, t, FAKE_ROWS[t]);
  console.log(`userB INSERT ${t}: status=${ins.status} body=${ins.body.slice(0, 150)}`);
}

console.log('\n=== DONE — expected: every anon/userA/userB call above returns 401/403/404-style PostgREST denial (never 200/201) ===');
