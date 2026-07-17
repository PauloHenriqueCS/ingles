import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from './_auth';
import { methodGuard, sizeGuard, PAYLOAD_LIMITS, TIMEOUTS, jsonError, safeLog, sanitizeProviderError } from './_helpers';
import { applyRateLimit } from './_rateLimit';
import { executeAiGatewayCall, getProductionDeps } from './_ai-gateway/index';
import type { GatewayUsageMetric } from './_ai-gateway/index';

const AI_MODEL = 'gpt-4o-mini';

// Only letters, digits, spaces, hyphens, and apostrophes — enough for any grammar name.
// Prevents injection through the cache key.
const GRAMMAR_NAME_RE = /^[\p{L}\p{N}\s'\-,.()]+$/u;
const GRAMMAR_NAME_MAX = 100;

function buildPrompt(grammarName: string): string {
  return `Explique o tópico gramatical "${grammarName}" para brasileiros adultos aprendendo inglês.

Retorne SOMENTE JSON válido. Sem markdown, sem texto antes ou depois.

{
  "name": "${grammarName}",
  "summaryPt": "o que é e por que importa — 2 a 3 frases em português",
  "whenToUse": [
    "situação específica com exemplo entre parênteses",
    "outra situação com exemplo"
  ],
  "structure": {
    "affirmative": "Subject + ...",
    "negative": "Subject + do/does not + ...",
    "question": "Do/Does + Subject + ...?"
  },
  "examples": [
    { "english": "frase completa em inglês", "portuguese": "tradução natural em português" }
  ],
  "commonMistakes": [
    { "wrong": "frase incorreta", "correct": "frase correta", "explanationPt": "por que está errado e como corrigir" }
  ],
  "tips": [
    "dica prática — começa com verbo no imperativo: Use, Lembre, Preste atenção em..."
  ],
  "traps": [
    "armadilha típica de brasileiros — por que acontece (influência do português) e como evitar"
  ],
  "finalSummaryPt": "resumo em até 3 linhas do que é essencial saber sobre este tópico"
}

Requisitos obrigatórios:
- whenToUse: mínimo 4 situações com exemplos entre parênteses
- examples: mínimo 5 exemplos variados (afirmativa, negativa, pergunta, contextos diferentes)
- commonMistakes: mínimo 5 erros típicos de brasileiros
- tips: 3 a 5 dicas práticas e aplicáveis
- traps: 3 a 5 armadilhas específicas de falantes de português
- Todas as explicações em português; toda gramática e exemplos em inglês`;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
  }
}

function serviceRoleClient() {
  const url = process.env.VITE_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// ── Metric extractor — reads from SDK response, never invents values ──────────

function extractGrammarMetrics(completion: ChatCompletion): GatewayUsageMetric[] {
  const metrics: GatewayUsageMetric[] = [];

  // Always record one request per provider call.
  metrics.push({
    metricKey: 'provider_requests',
    unitType: 'request',
    quantity: 1,
    isBillable: false,
    measurementSource: 'provider_response',
  });

  const usage = completion.usage;
  if (!usage) return metrics;

  if (usage.prompt_tokens != null) {
    metrics.push({
      metricKey: 'input_text_tokens',
      unitType: 'token',
      quantity: usage.prompt_tokens,
      isBillable: true,
      measurementSource: 'provider_response',
    });
  }

  if (usage.completion_tokens != null) {
    metrics.push({
      metricKey: 'output_text_tokens',
      unitType: 'token',
      quantity: usage.completion_tokens,
      isBillable: true,
      measurementSource: 'provider_response',
    });
  }

  // Only record when actually provided and non-zero — do not invent values.
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
  if (cachedTokens != null && cachedTokens > 0) {
    metrics.push({
      metricKey: 'cached_input_tokens',
      unitType: 'token',
      quantity: cachedTokens,
      isBillable: false,
      measurementSource: 'provider_response',
    });
  }

  return metrics;
}

export default async function handler(req: any, res: any) {
  if (!methodGuard(req, res, ['POST'])) return;
  if (!sizeGuard(req, res, PAYLOAD_LIMITS.GRAMMAR)) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;
  const { userId } = auth;

  const { grammarName } = req.body ?? {};
  if (!grammarName || typeof grammarName !== 'string') {
    return jsonError(res, 400, 'INVALID_REQUEST', 'grammarName é obrigatório.');
  }

  const trimmed = grammarName.trim();

  if (trimmed.length === 0 || trimmed.length > GRAMMAR_NAME_MAX) {
    return jsonError(res, 400, 'INVALID_REQUEST', `O nome do tópico deve ter entre 1 e ${GRAMMAR_NAME_MAX} caracteres.`);
  }
  if (!GRAMMAR_NAME_RE.test(trimmed)) {
    return jsonError(res, 400, 'INVALID_REQUEST', 'Nome do tópico contém caracteres inválidos.');
  }

  if (!await applyRateLimit(res, userId, 'grammar-explanation')) return;

  // ── Cache read (user-authed client — RLS ge_select allows authenticated reads) ──
  const { supabase } = auth;
  try {
    const { data: cached } = await supabase
      .from('grammar_explanations')
      .select('content')
      .ilike('name', trimmed)
      .maybeSingle();

    if (cached?.content) {
      return res.json({ content: cached.content, cached: true });
    }
  } catch {
    // Cache miss or error — proceed to generate
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return jsonError(res, 503, 'AI_UNAVAILABLE', 'O serviço de explicação não está configurado.');

  // ── Gateway-wrapped OpenAI call ────────────────────────────────────────────
  const deps = getProductionDeps();
  const correlationId = deps.uuidGen();
  const openai = new OpenAI({ apiKey, timeout: TIMEOUTS.MEDIUM, maxRetries: 0 });

  let completion: ChatCompletion | undefined;
  try {
    completion = await executeAiGatewayCall<ChatCompletion>(
      {
        featureKey: 'writing.explain_grammar',
        provider: 'openai',
        service: 'chat.completions',
        model: AI_MODEL,
        userId,
        initiatedByUserId: userId,
        actorType: 'user',
        executionLocation: 'backend',
        correlationId,
        attemptNumber: 1,
        callSequence: 1,
        resourceType: 'grammar_explanation',
      },
      () => openai.chat.completions.create({
        model: AI_MODEL,
        temperature: 0.7,
        messages: [
          {
            role: 'system',
            content: 'Você é um professor particular de inglês para brasileiros adultos. Suas explicações são claras, práticas e focadas nos erros típicos de falantes de português brasileiro.',
          },
          { role: 'user', content: buildPrompt(trimmed) },
        ],
      }),
      deps,
      extractGrammarMetrics,
    );
  } catch (err) {
    const { code, status } = sanitizeProviderError(err);
    if (code === 'AI_TIMEOUT') {
      safeLog('grammar-explanation', 'timeout', status);
      return jsonError(res, status, code, 'O serviço demorou para responder. Tente novamente.');
    }
    safeLog('grammar-explanation', 'provider_error', status);
    return jsonError(res, status, code, 'O serviço está temporariamente indisponível. Tente novamente.');
  }

  const raw = completion?.choices[0]?.message?.content ?? '';
  const content = parseJson(raw);
  if (!content) {
    return jsonError(res, 500, 'INTERNAL_ERROR', 'Não foi possível gerar a explicação. Tente novamente.');
  }

  // ── Cache write — service role only; users cannot write directly ──────────
  const srClient = serviceRoleClient();
  if (srClient) {
    try {
      await srClient
        .from('grammar_explanations')
        .insert({ name: trimmed, content });
    } catch {
      // Cache write failed — not fatal; response is still returned
    }
  }

  return res.json({ content, cached: false });
}
