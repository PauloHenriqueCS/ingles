/**
 * The "buy more minutes / see plans" action must be a popup that opens on its
 * own — the inline CTA was getting buried below the fold. It auto-opens the
 * moment the balance hits 0 (a session ended by balance) and every time the
 * screen is entered with 0 balance, and is dismissible. Static-wiring assertions
 * per this repo's convention.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '..', 'ConversationView.tsx'), 'utf8');

describe('ConversationView exhausted-balance popup', () => {
  it('defines a modal component with the buy/plans CTA', () => {
    expect(src).toContain('function ConversationExhaustedModal');
    expect(src).toContain('data-testid="conversation-exhausted-modal-cta"');
    expect(src).toMatch(/role="dialog"/);
  });

  it('auto-opens when the balance is exhausted, not during an active/connecting call', () => {
    const effect = src.slice(src.indexOf('Auto-open the exhausted-balance popup'), src.indexOf('Auto-open the exhausted-balance popup') + 700);
    expect(effect).toContain('conversationBlocked');
    expect(effect).toContain("session.status === 'active'");
    expect(effect).toContain('setShowExhaustedModal(true)');
  });

  it('renders the popup gated on exhausted balance + not in a call, and is dismissible', () => {
    expect(src).toMatch(/showExhaustedModal && !isActive && !isConnecting && conversation\?\.enabled && conversationBlocked/);
    expect(src).toMatch(/onClose=\{\(\) => setShowExhaustedModal\(false\)\}/);
    // trial → plans, paid → minute packages (the modal picks by extraPurchaseEnabled)
    expect(src).toMatch(/canBuyPackages \? onBuyMinutes : onSubscribe/);
  });
});
