-- =============================================================================
-- MIGRATION: 20260802221500_conversation_minute_packages_grants
-- Projeto: Orodim
--
-- Aplicada automaticamente por .github/workflows/homologation.yml
-- (supabase db push) após push em develop. Não aplicar manualmente no SQL
-- Editor — isso desalinha o histórico de `supabase migration list`.
--
-- Causa raiz (diagnosticada por leitura direta de information_schema.
-- role_table_grants + has_table_privilege() + reprodução do erro via
-- SET LOCAL ROLE, em homologação): 20260727230000_conversation_minute_
-- packages_catalog.sql criou a tabela, habilitou RLS e criou as 4 policies,
-- mas nunca emitiu nenhum GRANT. Sem GRANT, o Postgres nega no nível de ACL
-- (erro 42501 insufficient_privilege — "permission denied for table
-- conversation_minute_packages") antes mesmo de chegar a avaliar as policies
-- de RLS — reproduzido com SET LOCAL ROLE authenticated; SELECT ... , que
-- retorna exatamente esse erro. Isso afetava qualquer papel não-owner:
--   - o Orodim Admin (dashboard), conectado como `authenticated` via cookie,
--     via exatamente esse erro em /pacotes-de-minutos (o problema relatado);
--   - o próprio backend deste app (getSharedServiceClient(), papel
--     `service_role`, usado por listPublishedMinutePackages para leitura
--     pública do catálogo) também estava sujeito ao mesmo erro —
--     BYPASSRLS pula a avaliação de policies, nunca a checagem de GRANT
--     (confirmado com o mesmo teste SET LOCAL ROLE service_role).
-- USAGE em public e EXECUTE em is_active_admin()/can_manage_plans() para
-- authenticated já existiam (EXECUTE está concedido a PUBLIC desde a criação
-- das funções) — verificados e confirmados como NÃO faltantes, por isso esta
-- migration não concede EXECUTE algum.
--
-- Correção: apenas GRANT/REVOKE de privilégios de tabela. Nenhuma policy é
-- criada, alterada ou removida — as 4 policies existentes
-- (conversation_minute_packages_read/write/update/delete, todas já corretas)
-- continuam sendo a proteção efetiva de quem pode ler ou escrever, agora que
-- o papel consegue de fato alcançar a avaliação delas:
--   - `authenticated`: SELECT, INSERT, UPDATE apenas. Sem DELETE —
--     arquivamento é feito por UPDATE (status='archived'), nunca DELETE.
--     Quem realmente pode ler/escrever continua decidido pelas policies
--     (is_active_admin() para SELECT, can_manage_plans() para INSERT/UPDATE).
--   - `service_role`: SELECT apenas — é tudo que o código atual usa
--     (listPublishedMinutePackages é somente leitura; nenhum INSERT/UPDATE/
--     DELETE deste app passa por esta tabela).
--   - `PUBLIC` e `anon`: REVOKE ALL explícito — nenhum acesso.
-- GRANT/REVOKE são idempotentes por natureza (reexecutar não muda o estado).
--
-- Fora de escopo, de propósito: qualquer mudança no dashboard, em regras
-- comerciais, nos dados dos três pacotes (pacote-300/600/900-min continuam
-- draft/inactive/IDs nulos, sem nenhum UPDATE aqui), em checkout ou
-- integração com lojas. Esta migration não fortalece nem enfraquece nenhuma
-- policy — apenas concede o privilégio de tabela que faltava para que as
-- policies existentes consigam ser avaliadas.
-- =============================================================================

REVOKE ALL ON public.conversation_minute_packages FROM PUBLIC;
REVOKE ALL ON public.conversation_minute_packages FROM anon;

GRANT SELECT, INSERT, UPDATE ON public.conversation_minute_packages TO authenticated;
GRANT SELECT ON public.conversation_minute_packages TO service_role;

-- Após aplicar: execute supabase/verify_schema.sql, e confirme os
-- privilégios:
--   SELECT grantee, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE table_schema = 'public' AND table_name = 'conversation_minute_packages'
--   ORDER BY grantee, privilege_type;
-- deve retornar: authenticated (INSERT, SELECT, UPDATE), service_role
-- (SELECT), postgres (owner, todos os privilégios) — nenhuma linha para
-- anon ou PUBLIC.
