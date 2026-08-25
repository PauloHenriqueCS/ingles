import { ExternalLink } from 'lucide-react';
import { AppIcon } from './AppIcon';
import { SUBSCRIPTION_MESSAGES } from '../domain/subscription/subscription-copy';
import { APPLE_EULA_URL, PRIVACY_POLICY_URL } from '../domain/subscription/legal-links';
import { openExternalUrl } from '../lib/openExternalUrl';

interface Props {
  /** True on iOS/iPadOS only — gates Apple's Standard EULA link. Passed from
   *  the caller (isIOSApp) so the gating is a pure, testable prop, never read
   *  from Capacitor inside this presentational component. Android/web: false. */
  showAppleEula: boolean;
}

/**
 * Legal + compliance footer for the subscription flow (App Store Guideline
 * 3.1.2(c)). Always rendered on the paywall, BEFORE any purchase, on every
 * platform — never hidden inside settings/profile:
 *
 *  - the auto-renewal disclosure (all platforms);
 *  - a functional Privacy Policy link (all platforms);
 *  - a functional Apple Standard EULA link (iOS/iPadOS ONLY — never Android/web).
 *
 * Links are real anchors (functional href) AND open reliably inside the native
 * app via openExternalUrl (Capacitor Browser) — we preventDefault so the
 * in-app browser is always used, while the href stays inspectable/correct.
 */
export default function SubscriptionLegalLinks({ showAppleEula }: Props) {
  const handleOpen = (url: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    void openExternalUrl(url);
  };

  return (
    <section className="pt-2 space-y-2 text-center" data-testid="subscription-legal-links">
      <p className="text-xs text-slate-500 leading-relaxed px-1">
        {SUBSCRIPTION_MESSAGES.autoRenewDisclosure}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5">
        <a
          href={PRIVACY_POLICY_URL}
          onClick={handleOpen(PRIVACY_POLICY_URL)}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="legal-link-privacy"
          className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 underline underline-offset-2 hover:text-slate-200 transition-colors"
        >
          {SUBSCRIPTION_MESSAGES.privacyPolicyLinkLabel}
          <AppIcon icon={ExternalLink} className="w-3 h-3 shrink-0 opacity-70" />
        </a>

        {showAppleEula && (
          <a
            href={APPLE_EULA_URL}
            onClick={handleOpen(APPLE_EULA_URL)}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="legal-link-eula"
            className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 underline underline-offset-2 hover:text-slate-200 transition-colors"
          >
            {SUBSCRIPTION_MESSAGES.termsOfUseLinkLabel}
            <AppIcon icon={ExternalLink} className="w-3 h-3 shrink-0 opacity-70" />
          </a>
        )}
      </div>
    </section>
  );
}
