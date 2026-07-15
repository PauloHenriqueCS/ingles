# Rollback do Motor V2

## Estado normal (produção)

Motor V2 ativo. Nenhuma variável de ambiente necessária — o código já assume V2 como padrão.

```
LEARNING_ENGINE_VERSION  →  não definida  →  v2 (padrão)
```

---

## Critérios para acionar rollback

Acionar rollback se qualquer um dos seguintes ocorrer:

- Login ou página inicial indisponíveis
- Perda ou corrupção de dados do usuário
- Missão não pode ser gerada após 2 retries
- Revisão de texto falhando consistentemente
- Dashboard quebrando para o usuário
- RLS falhando (usuário vê dados de outro usuário)
- Duplicidade de promoção criada
- Erros críticos não-recuperáveis recorrentes
- Custo extremamente anormal (10× do esperado)
- Migrations inconsistentes ou rolladas parcialmente

**Não acionar rollback** por:
- Erros visuais pequenos ou de estilo
- Falhas isoladas de Azure Speech (retry funciona)
- Lentidão temporária

---

## Procedimento de rollback (V2 → V1)

1. Na Vercel, adicionar variável de ambiente de produção:
   ```
   LEARNING_ENGINE_VERSION=v1
   ```

2. Fazer redeploy (Vercel aplica automaticamente ao salvar a variável).

3. Validar após deploy:
   - Abrir a aplicação e fazer login
   - Verificar que uma missão pode ser carregada
   - Verificar que o dashboard carrega
   - Verificar que textos anteriores ainda aparecem
   - Confirmar que nenhum dado V2 foi apagado (missões, níveis, evidências)

4. Registrar o motivo do rollback nos logs ou issues do projeto.

**O rollback NÃO:**
- Apaga migrations
- Apaga dados V2 (learner_skill_profiles, promotion_evaluations, etc.)
- Reverte níveis calculados pelo V2
- Desfaz idempotency keys da recalibração

---

## Procedimento de retorno ao V2 (V1 → V2)

1. Resolver a causa raiz do rollback.

2. Na Vercel, remover a variável `LEARNING_ENGINE_VERSION` (ou setar para `v2`).

3. Fazer redeploy.

4. Validar novamente: login, dashboard, missão, calendário.

5. Não é necessário re-executar a recalibração — os dados V2 foram preservados.

---

## Tabelas críticas (não apagar no rollback)

| Tabela | Motivo |
|--------|--------|
| `learner_skill_profiles` | Níveis por habilidade do usuário |
| `learner_skill_level_history` | Histórico de promoções |
| `promotion_evaluations` | Decisões de promoção com engine_version |
| `promotion_checkpoints` | Checkpoints de promoção |
| `learner_grammar_mastery` | Estado de domínio gramatical |
| `learner_grammar_evidence` | Evidências de gramática |
| `learner_vocabulary_mastery` | Domínio de vocabulário |
| `learner_vocabulary_evidence` | Evidências de vocabulário |
| `writing_missions` | Missões canônicas |
| `writing_rewrite_attempts` | Tentativas de reescrita |
| `engine_activation_log` | Histórico de ativações e recalibrações |

---

## Backup

Antes de qualquer operação destrutiva, criar backup via Supabase Dashboard:

1. Acessar https://app.supabase.com → projeto → Settings → Database
2. Criar Point-in-Time Recovery snapshot ou usar o painel de backups automáticos
3. Registrar: data/hora do backup, operação que motivou o backup

Tabelas com dados de usuário que não podem ser perdidas:
- `writing_entries`, `english_reviews` — textos e revisões
- `pronunciation_assessments` — análises de pronúncia
- `conversation_sessions` — sessões de conversação
- `learner_skill_profiles` — níveis calculados
- `english_learning_memory` — memória de aprendizado (nível legado)
