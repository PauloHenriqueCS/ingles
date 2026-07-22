import { runtimeAttribute } from './runtimeEnvironment';

/**
 * The same NotAllowedError/PermissionDeniedError fires both for "the user
 * just tapped Deny" and for "the OS is silently withholding the prompt after
 * an earlier denial" (Android stops showing the runtime permission dialog at
 * all once a user has denied it enough times — confirmed on a physical
 * device: after one explicit "Negar", subsequent requests resolve denied
 * with no UI shown, see GrantPermissionsViewModel entries in Logcat). A
 * rejected getUserMedia() promise can't tell those two cases apart, so the
 * message always describes the manual recovery path instead of suggesting
 * "try again" — retrying alone can never recover from the suppressed state.
 *
 * `attribute` defaults to the real runtime so callers just do
 * getMicPermissionDeniedMessage(); tests pass it explicitly instead of
 * mocking runtimeEnvironment's module-load-time consts.
 */
export function getMicPermissionDeniedMessage(
  attribute: ReturnType<typeof runtimeAttribute> = runtimeAttribute(),
): string {
  if (attribute === 'android-app') {
    return 'O acesso ao microfone foi negado. O Android não mostra esse aviso de novo automaticamente — abra Configurações > Apps > Lemon > Permissões > Microfone e permita o acesso.';
  }
  if (attribute === 'ios-app') {
    return 'O acesso ao microfone foi negado. Abra Ajustes do iPhone > Lemon > Microfone e permita o acesso.';
  }
  return 'O navegador negou o acesso ao microfone. Toque no ícone de cadeado/informações ao lado do endereço do site, permita o microfone nas permissões e recarregue a página.';
}
