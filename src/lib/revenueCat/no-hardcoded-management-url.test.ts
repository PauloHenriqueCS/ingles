import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

// Every file that could plausibly render or wire the "Gerenciar assinatura"
// affordance — the button must only ever open a real, RevenueCat-returned
// CustomerInfo.managementURL, never a fixed/generic App Store link baked
// into the app. A literal domain match here means someone hardcoded a
// fallback, which this task explicitly forbids.
const FILES_TO_SCAN = [
  'src/lib/revenueCat/revenueCatClient.ts',
  'src/lib/revenueCat/revenueCatTypes.ts',
  'src/hooks/useNativeSubscriptionPurchase.ts',
  'src/components/SubscriptionView.tsx',
  'src/components/SubscriptionPlanCard.tsx',
  'src/domain/subscription/native-subscription-actions.ts',
  'src/domain/subscription/subscription-copy.ts',
];

const FORBIDDEN_PATTERNS = [
  /apps\.apple\.com/i,
  /itunes\.apple\.com/i,
  /manageSubscriptions/i,
];

describe('no hardcoded App Store management link in production code', () => {
  for (const relativePath of FILES_TO_SCAN) {
    it(`${relativePath} never contains a fixed App Store URL/deep-link`, () => {
      const content = readFileSync(join(REPO_ROOT, relativePath), 'utf8');
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(content).not.toMatch(pattern);
      }
    });
  }
});
