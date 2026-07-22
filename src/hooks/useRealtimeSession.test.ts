import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getMicErrorMessage } from './useRealtimeSession';

// getUserMedia() failures must be classified into distinct, non-technical
// user messages (Android/Capacitor mic bug — see LemonWebChromeClient.java
// for the native-side fix) instead of collapsing into one generic message
// that hides the real cause.
describe('getMicErrorMessage', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('classifies NotAllowedError as a permission denial', () => {
    const result = getMicErrorMessage(new DOMException('denied', 'NotAllowedError'));
    expect(result.code).toBe('MIC_PERMISSION_DENIED');
    expect(result.message).not.toMatch(/NotAllowedError/);
  });

  it('classifies NotFoundError as no microphone available', () => {
    const result = getMicErrorMessage(new DOMException('no device', 'NotFoundError'));
    expect(result.code).toBe('MIC_NOT_FOUND');
  });

  it('classifies NotReadableError distinctly instead of falling back to the generic message', () => {
    const result = getMicErrorMessage(new DOMException('Could not start audio source', 'NotReadableError'));
    expect(result.code).toBe('MIC_NOT_READABLE');
    expect(result.message).not.toBe('Não foi possível acessar o microfone.');
    // Never leak the raw DOMException text into the user-facing message.
    expect(result.message).not.toMatch(/Could not start audio source/);
  });

  it('falls back to the generic message for an unclassified DOMException', () => {
    const result = getMicErrorMessage(new DOMException('boom', 'AbortError'));
    expect(result.code).toBe('MIC_ERROR');
    expect(result.message).toBe('Não foi possível acessar o microfone.');
  });

  it('falls back to the generic message for a non-DOMException error', () => {
    const result = getMicErrorMessage(new Error('unexpected'));
    expect(result.code).toBe('MIC_ERROR');
  });

  it('logs the DOMException name/message to console.error for dev diagnosis without touching the user message', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getMicErrorMessage(new DOMException('Could not start audio source', 'NotReadableError'));
    expect(spy).toHaveBeenCalledWith('[mic] getUserMedia failed', { name: 'NotReadableError', message: 'Could not start audio source' });
  });
});
