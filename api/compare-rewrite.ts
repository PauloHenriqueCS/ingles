import OpenAI from 'openai';
import { requireAuth } from './_auth';

const AI_MODEL = 'gpt-4o-mini';

const SYSTEM_PROMPT = `Você é um professor de inglês para brasileiros adultos iniciantes.

O aluno escreveu um texto em inglês, recebeu uma correção e depois tentou criar uma segunda versão corrigindo os próprios erros.

Sua tarefa é comparar:
1. o texto original;
2. o texto corrigido de referência;
3. a versão 2 escrita pelo aluno;
4. os principais erros apontados na primeira revisão.

Avalie se o aluno realmente melhorou o texto.

Você deve responder em português do Brasil, exceto nos exemplos em inglês.

Seja didático, direto e encorajador.
Não humilhe o aluno.
Não diga apenas que está certo ou errado.
Explique o que melhorou e o que ainda precisa ser treinado.

Retorne somente JSON válido.
Não use markdown.
Não escreva nada antes ou depois do JSON.

Formato obrigatório:

{
  "improvementScore": number,
  "fixedMistakesCount": number,
  "remainingMistakesCount": number,
  "fixedMistakes": [
    {
      "mistake": string,
      "original": string,
      "rewrite": string,
      "feedback": string
    }
  ],
  "remainingMistakes": [
    {
      "mistake": string,
      "rewrite": string,
      "correct": string,
      "feedback": string
    }
  ],
  "newIssues": [
    {
      "issue": string,
      "rewrite": string,
      "suggestion": string
    }
  ],
  "overallFeedback": string,
  "nextAction": string
}

Regras:
- improvementScore deve ir de 0 a 100.
- fixedMistakesCount deve indicar quantos erros da primeira revisão foram corrigidos na versão 2.
- remainingMistakesCount deve indicar quantos erros ainda permaneceram.
- fixedMistakes deve listar erros que o aluno conseguiu corrigir.
- remainingMistakes deve listar erros que o aluno ainda não corrigiu.
- newIssues deve listar novos problemas criados na versão 2, se existirem.
- overallFeedback deve resumir a evolução da versão 1 para a versão 2.
- nextAction deve sugerir uma tarefa curta para fixar o aprendizado.
- Se a versão 2 for muito semelhante ao texto corrigido de referência, diga de forma gentil que parece ter sido copiada e incentive o aluno a tentar escrever com as próprias palavras.
- Se a versão 2 for idêntica ao texto original, diga que ainda não houve melhora suficiente e oriente o aluno a focar nos erros apontados.
- Se a versão 2 estiver melhor, reconheça claramente a melhora.
- Se a versão 2 tiver menos erros mas ainda não estiver perfeita, valorize o progresso e explique o próximo ajuste.
- Não reescrever o texto inteiro para o aluno.`;

function buildUserMessage(
  originalText: string,
  correctedText: string,
  rewriteText: string,
  mainMistakes: { original: string; correct: string; explanation: string }[]
): string {
  const lines: string[] = [];
  lines.push('=== TEXTO ORIGINAL DO ALUNO ===');
  lines.push(originalText.trim());
  lines.push('');
  lines.push('=== TEXTO CORRIGIDO DE REFERÊNCIA ===');
  lines.push(correctedText.trim());
  lines.push('');
  lines.push('=== VERSÃO 2 ESCRITA PELO ALUNO ===');
  lines.push(rewriteText.trim());
  lines.push('');
  if (mainMistakes.length > 0) {
    lines.push('=== PRINCIPAIS ERROS DA PRIMEIRA REVISÃO ===');
    mainMistakes.forEach((m, i) => {
      lines.push(`${i + 1}. Você escreveu: "${m.original}" → Correto: "${m.correct}"`);
      if (m.explanation) lines.push(`   Explicação: ${m.explanation}`);
    });
  }
  return lines.join('\n');
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).end();

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY não configurada.' });

  const { originalText, correctedText, rewriteText, mainMistakes } = req.body ?? {};

  if (!originalText?.trim() || !correctedText?.trim() || !rewriteText?.trim()) {
    return res.status(400).json({ error: 'originalText, correctedText e rewriteText são obrigatórios.' });
  }

  try {
    const openai = new OpenAI({ apiKey });

    const completion = await openai.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: buildUserMessage(
            originalText,
            correctedText,
            rewriteText,
            Array.isArray(mainMistakes) ? mainMistakes : []
          ),
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? '';

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return res.status(500).json({ error: 'Resposta inválida da IA. Tente novamente.' });
      try { parsed = JSON.parse(match[0]); }
      catch { return res.status(500).json({ error: 'Resposta inválida da IA. Tente novamente.' }); }
    }

    const result = {
      improvementScore: Number(parsed.improvementScore) || 0,
      fixedMistakesCount: Number(parsed.fixedMistakesCount) || 0,
      remainingMistakesCount: Number(parsed.remainingMistakesCount) || 0,
      fixedMistakes: Array.isArray(parsed.fixedMistakes) ? parsed.fixedMistakes : [],
      remainingMistakes: Array.isArray(parsed.remainingMistakes) ? parsed.remainingMistakes : [],
      newIssues: Array.isArray(parsed.newIssues) ? parsed.newIssues : [],
      overallFeedback: String(parsed.overallFeedback || 'Análise concluída.'),
      nextAction: String(parsed.nextAction || 'Continue praticando!'),
    };

    return res.json({ result });
  } catch (err: any) {
    console.error('compare-rewrite error:', err);
    return res.status(500).json({ error: err?.message ?? 'Erro interno ao comparar.' });
  }
}
