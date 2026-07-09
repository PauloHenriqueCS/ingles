export default async function handler(req: any, res: any) {
  return res.status(200).json({
    ok: true,
    nodeVersion: process.version,
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
  });
}
