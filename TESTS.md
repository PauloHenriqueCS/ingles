# Test Matrix

## Overview

| Suite | File | Project | Needs Browser | Needs Backend |
|-------|------|---------|--------------|---------------|
| Baseline | `01-baseline.spec.ts` | node-checks | No | No |
| Security Static | `02-security-static.spec.ts` | node-checks | No | No |
| Recorder (mocked) | `03-recorder-mocked.spec.ts` | chromium | Yes | No |
| API Integration | `04-api-integration.spec.ts` | chromium | Yes | No (mocked) |
| RLS | `05-rls.spec.ts` | chromium-authenticated | Yes | Yes (real) |
| Concurrency | `06-concurrency.spec.ts` | chromium-authenticated | Yes | Yes (real) |
| Azure Real | `07-azure-real.spec.ts` | chromium-authenticated | Yes | Yes (real + Azure) |
| Accessibility | `08-accessibility.spec.ts` | chromium | Yes | No (mocked) |
| Dashboard | `09-dashboard.spec.ts` | chromium | Yes | No (mocked) |
| Calendar | `10-calendar.spec.ts` | chromium | Yes | No (mocked) |
| Smoke | `11-smoke.spec.ts` | chromium | Yes | No (mocked) |

## Projects

### `node-checks` — Node.js only, no browser
Runs without a browser or dev server. Executes `execSync` commands (vitest, tsc, vite build).

### `chromium` — Chrome desktop, mocked backend
Starts the local dev server (`npm run dev`). Supabase auth and REST calls are intercepted via `page.route()` and fulfilled with fixture data. No real credentials required.

### `chromium-authenticated` — Chrome desktop, real Supabase + Azure
Requires `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and valid test user credentials. Runs real RLS queries against the database. `07-azure-real.spec.ts` also requires `VITE_AZURE_SPEECH_KEY`.

## Running tests

```bash
# All node-only checks (baseline + security-static)
npm run test:e2e:node

# All mocked browser tests (sections 3, 4, 8, 9, 10, 11)
npm run test:e2e:chrome

# Specific file
npx playwright test tests/e2e/11-smoke.spec.ts --project=chromium

# All tests (requires real credentials for authenticated project)
npm run test:e2e

# Unit tests only
npm test
```

## Environment variables

| Variable | Required for | Purpose |
|----------|-------------|---------|
| `VITE_SUPABASE_URL` | chromium-authenticated | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | chromium-authenticated | Supabase anonymous key |
| `VITE_AZURE_SPEECH_KEY` | 07-azure-real | Azure Cognitive Services key |
| `VITE_AZURE_SPEECH_REGION` | 07-azure-real | Azure region (e.g. `eastus`) |
| `E2E_BASE_URL` | all browser | Override dev server URL (default: `http://localhost:5173`) |

## Test user fixtures

Defined in `tests/e2e/helpers/fixtures.ts`:

| Factory | Description |
|---------|-------------|
| `setupNewUser(page)` | No skill profiles, no entries, no history |
| `setupA1User(page)` | Writing skill at A1, one promotion eval in progress |
| `setupA1NearPromotion(page)` | A1 at 82% progress toward A2 |
| `setupUserWithWriting(page)` | Completed writing entry with AI review |
| `mockDashboardData(page, opts)` | Low-level: mock individual REST tables |
| `mockCalendarData(page, opts)` | Low-level: mock calendar-specific REST tables |

## CI pipeline

The `.github/workflows/ci.yml` runs on every push to `main`/`dev` and all pull requests to `main`:

1. **typecheck** — `npx tsc --noEmit`
2. **unit-tests** — `npm test` (Vitest)
3. **build** — `npm run build` (Vite, with placeholder env)
4. **e2e-node-checks** — `playwright test --project=node-checks`
5. **e2e-browser** — smoke + dashboard + calendar tests (mocked, chromium)

Real-backend tests (`05-rls`, `06-concurrency`, `07-azure-real`) are excluded from CI by default since they require live credentials. Run them locally or in a dedicated staging workflow.

## Adding new tests

1. Create `tests/e2e/NN-description.spec.ts`
2. Add it to the appropriate `testMatch` array in `playwright.config.ts`
3. Use `setupFakeAuth` + REST mocking for browser tests that don't need a real backend
4. Update this matrix

## Smoke test checklist (Section 11)

| # | Test | What it validates |
|---|------|------------------|
| 1 | App carrega sem crash | No JS errors, body visible |
| 2 | Auth gate | Unauthenticated user sees login UI |
| 3 | Usuário autenticado vê tela principal | Logged-in user reaches main view |
| 4 | Dashboard acessível | Menu navigation reaches dashboard |
| 5 | Calendário acessível | Menu navigation reaches calendar |
| 6 | Sem erros JS | No uncaught exceptions on load |
| 7 | Ano dinâmico | "Progresso 2026" not hardcoded |
| 8 | Nomes de tabelas ocultos | No DB identifiers in UI text |
| 9 | Isolamento RLS | User B cannot see User A's localStorage data |
| 10 | Resiliência offline | App renders even when REST returns 503 |
