import OpenAI from 'openai';

export default async function handler(req: any, res: any) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(200).json({ ok: false, reason: 'no key' });

  try {
    const openai = new OpenAI({ apiKey });
    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Say ok' }],
      max_tokens: 5,
    });
    return res.status(200).json({ ok: true, reply: r.choices[0]?.message?.content });
  } catch (err: any) {
    return res.status(200).json({ ok: false, error: err?.message });
  }
}
