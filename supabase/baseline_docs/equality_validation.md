# Etapa 5 — Prova de igualdade estrutural (proposta, não executada)

Objetivo: depois que o baseline (+ seed) for aplicado em homologação, rodar a **mesma query de fingerprint** nos dois projetos (produção `jiuurvheeuwmayrfnqgm` e homologação `ahszqexfzpbirdlkmdci`) e comparar o resultado. Diferença zero nesse fingerprint = estrutura idêntica. Nada aqui foi executado — é a query pronta para rodar quando o usuário autorizar a aplicação do baseline.

## Por que fingerprint em vez de "SELECT * FROM information_schema em cada tabela e diff manual"

Comparar linha a linha entre dois bancos exige rodar a mesma query nos dois lados e comparar fora do banco (nenhuma ferramenta aqui tem acesso simultâneo aos dois projetos numa única query, já que são projetos Supabase distintos). A abordagem prática:

1. Rodar `equality_fingerprint.sql` (abaixo) contra produção → salvar o hash de cada categoria.
2. Rodar o mesmo script contra homologação → salvar o hash de cada categoria.
3. Comparar os dois conjuntos de hashes (categoria a categoria). Qualquer linha com hash diferente aponta exatamente qual categoria diverge (ex.: "policies" diferente = alguma policy foi criada/alterada/esquecida).

## Script de fingerprint (rodar como está, sem modificação, nos dois projetos)

```sql
-- Cada linha retorna: categoria | contagem de objetos | hash md5 agregado (ordem determinística)
-- Hash agregado captura TEXTO da definição, não só nomes — pega mudança de tipo de coluna,
-- de expressão de policy, de corpo de função, etc.

SELECT 'extensions' AS categoria, count(*)::text,
  md5(string_agg(extname || ':' || extversion, ',' ORDER BY extname))
FROM pg_extension WHERE extname <> 'plpgsql'

UNION ALL
SELECT 'schemas_publicos', count(*)::text, md5(string_agg(nspname, ',' ORDER BY nspname))
FROM pg_namespace WHERE nspname NOT LIKE 'pg\_%' AND nspname NOT IN ('information_schema')

UNION ALL
SELECT 'enums', count(DISTINCT t.typname)::text,
  md5(string_agg(t.typname || ':' || e.enumlabel, ',' ORDER BY t.typname, e.enumsortorder))
FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public'

UNION ALL
SELECT 'tabelas_colunas', count(*)::text,
  md5(string_agg(c.relname || '.' || a.attname || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull || ':' || a.attidentity, ',' ORDER BY c.relname, a.attnum))
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
WHERE n.nspname = 'public' AND c.relkind = 'r'

UNION ALL
SELECT 'constraints', count(*)::text,
  md5(string_agg(conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid), ',' ORDER BY conrelid::regclass::text, conname))
FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'

UNION ALL
SELECT 'indexes', count(*)::text,
  md5(string_agg(indexname || ':' || indexdef, ',' ORDER BY tablename, indexname))
FROM pg_indexes WHERE schemaname = 'public'

UNION ALL
SELECT 'views', count(*)::text,
  md5(string_agg(c.relname || ':' || pg_get_viewdef(c.oid, true), ',' ORDER BY c.relname))
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'v'

UNION ALL
SELECT 'functions', count(*)::text,
  md5(string_agg(p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || p.prosecdef || ':' || md5(pg_get_functiondef(p.oid)), ',' ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)))
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'

UNION ALL
SELECT 'triggers', count(*)::text,
  md5(string_agg(c.relname || ':' || t.tgname || ':' || pg_get_triggerdef(t.oid), ',' ORDER BY c.relname, t.tgname))
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT t.tgisinternal

UNION ALL
SELECT 'rls_enabled', count(*) FILTER (WHERE relrowsecurity)::text,
  md5(string_agg(c.relname || ':' || c.relrowsecurity, ',' ORDER BY c.relname))
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'

UNION ALL
SELECT 'policies', count(*)::text,
  md5(string_agg(tablename || ':' || policyname || ':' || permissive || ':' || cmd || ':' || array_to_string(roles, ',') || ':' || coalesce(qual,'') || ':' || coalesce(with_check,''), ',' ORDER BY tablename, policyname))
FROM pg_policies WHERE schemaname IN ('public', 'storage')

UNION ALL
SELECT 'grants_tabelas', count(*)::text,
  md5(string_agg(table_name || ':' || grantee || ':' || privilege_type, ',' ORDER BY table_name, grantee, privilege_type))
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee IN ('anon','authenticated','service_role','postgres')

UNION ALL
SELECT 'cron_jobs', count(*)::text,
  md5(string_agg(jobname || ':' || schedule || ':' || command, ',' ORDER BY jobname))
FROM cron.job

ORDER BY 1;
```

## Resultado esperado

- **Zero diferenças estruturais**: toda linha (`extensions`, `schemas_publicos`, `enums`, `tabelas_colunas`, `constraints`, `indexes`, `views`, `functions`, `triggers`, `rls_enabled`, `policies`, `grants_tabelas`, `cron_jobs`) deve ter a **mesma contagem e o mesmo hash** nos dois projetos.
- **Diferenças aceitáveis, fora deste fingerprint**: dados em `auth.users`, contadores de linhas em tabelas operacionais, valores de `vault.secrets` (nomes iguais, valores diferentes por design), credenciais/URLs específicas de ambiente (ver `out_of_schema_config.md`).
- Se `functions` divergir mas `triggers`/`policies` não: normalmente indica uma função alterada sem seu trigger ter mudado — investigar direto pelo nome antes de reaplicar todo o baseline.
- Se `grants_tabelas` divergir: quase sempre um `ALTER DEFAULT PRIVILEGES` ou `GRANT` manual aplicado direto em um dos dois projetos, fora de migration — vale registrar como migration nova em vez de corrigir manualmente nos dois lados.

## Dados estruturais (fora do fingerprint de schema)

Para os dados estruturais do seed (Etapa 3), a validação equivalente é comparar contagem + hash por tabela listada no seed:

```sql
SELECT 'admin_roles', count(*), md5(string_agg(role || ':' || label, ',' ORDER BY role)) FROM public.admin_roles
UNION ALL SELECT 'admin_permissions', count(*), md5(string_agg(key, ',' ORDER BY key)) FROM public.admin_permissions
UNION ALL SELECT 'admin_role_permissions', count(*), md5(string_agg(role||':'||permission_key, ',' ORDER BY role, permission_key)) FROM public.admin_role_permissions
UNION ALL SELECT 'capability_definitions', count(*), md5(string_agg(key, ',' ORDER BY key)) FROM public.capability_definitions
UNION ALL SELECT 'plans', count(*), md5(string_agg(code, ',' ORDER BY code)) FROM public.plans
UNION ALL SELECT 'plan_versions', count(*), md5(string_agg(id::text||':'||status, ',' ORDER BY id)) FROM public.plan_versions
UNION ALL SELECT 'plan_capability_values', count(*), md5(string_agg(plan_version_id::text||':'||capability_key||':'||value::text, ',' ORDER BY plan_version_id, capability_key)) FROM public.plan_capability_values
UNION ALL SELECT 'ai_features', count(*), md5(string_agg(feature_key, ',' ORDER BY feature_key)) FROM public.ai_features
UNION ALL SELECT 'provider_pricing', count(*), md5(string_agg(id::text, ',' ORDER BY id)) FROM public.provider_pricing
UNION ALL SELECT 'app_config_definitions', count(*), md5(string_agg(key, ',' ORDER BY key)) FROM public.app_config_definitions;
```

Esperado: mesma contagem/hash em produção e homologação logo após aplicar o seed (Etapa 3) — e continuam iguais depois, já que essas tabelas não recebem escrita de usuários finais (só via funções administrativas).
