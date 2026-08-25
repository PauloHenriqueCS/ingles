import { describe, it, expect } from 'vitest';
import { PRIVACY_POLICY_URL, APPLE_EULA_URL } from './legal-links';

describe('subscription legal links (App Store Guideline 3.1.2(c))', () => {
  it('Privacy Policy points to the official Orodim URL', () => {
    expect(PRIVACY_POLICY_URL).toBe('https://www.orodim.com.br/privacy');
  });

  it('EULA points EXACTLY to Apple\'s Standard EULA (never an Orodim-specific terms URL)', () => {
    expect(APPLE_EULA_URL).toBe('https://www.apple.com/legal/internet-services/itunes/dev/stdeula/');
  });
});
