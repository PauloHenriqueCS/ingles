import { describe, it, expect } from 'vitest';
import { getMicPermissionDeniedMessage } from './micPermissionGuidance';

describe('getMicPermissionDeniedMessage', () => {
  it('tells Android app users to go to Settings > Apps > Lemon > Permissions, not iPhone/Chrome instructions', () => {
    const message = getMicPermissionDeniedMessage('android-app');
    expect(message).toMatch(/Configurações > Apps > Lemon > Permissões/);
    expect(message).not.toMatch(/iPhone/);
    expect(message).not.toMatch(/Chrome/);
  });

  it('tells iOS app users to go to Ajustes do iPhone, not Chrome', () => {
    const message = getMicPermissionDeniedMessage('ios-app');
    expect(message).toMatch(/Ajustes do iPhone/);
    expect(message).not.toMatch(/Chrome/);
  });

  it('gives browser-appropriate guidance on web, without naming a native Settings app path', () => {
    const message = getMicPermissionDeniedMessage('web');
    expect(message).toMatch(/navegador/);
    expect(message).not.toMatch(/Configurações > Apps/);
    expect(message).not.toMatch(/Ajustes do iPhone/);
  });

  it('defaults to a non-empty message when called with no argument', () => {
    expect(getMicPermissionDeniedMessage().length).toBeGreaterThan(0);
  });
});
