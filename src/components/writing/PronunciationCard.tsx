import { useState } from 'react';
import { Mic, ChevronRight, ChevronUp } from 'lucide-react';
import type { PronunciationEntitlements } from '../../domain/entitlements/entitlement-types';
import type { WritingUiStrings } from '../../i18n/writingUiStrings';
import PronunciationRecorder from '../PronunciationRecorder';

interface Props {
  referenceText: string;
  reviewId: string | null;
  pronunciation: PronunciationEntitlements | null;
  t: WritingUiStrings;
}

/**
 * Pronunciation is an OPTIONAL extra AFTER the writing is finished — never a
 * stepper step. On the Concluído screen it starts as a compact card; tapping
 * "Treinar pronúncia" expands it IN PLACE (no navigation, the stepper still
 * shows Concluído) to reveal the full recorder. The plan's practice allowance is
 * shown as context ("ilimitada no seu plano" / "N restantes"), derived from the
 * real entitlements — never hardcoded — and the franchise rule itself is
 * enforced inside the recorder.
 */
export default function PronunciationCard({ referenceText, reviewId, pronunciation, t }: Props) {
  const [expanded, setExpanded] = useState(false);

  const quotaLine = !pronunciation
    ? null
    : pronunciation.evaluations.unlimited
    ? t.pronQuotaUnlimited
    : t.pronQuotaRemaining(pronunciation.evaluations.remaining);

  return (
    <div className="bg-slate-800 rounded-xl overflow-hidden border border-slate-700">
      <div className="flex items-center gap-2 px-4 pt-4 pb-1">
        <Mic className="w-4 h-4 shrink-0 text-purple-400" strokeWidth={2} aria-hidden="true" />
        <p className="text-sm font-semibold text-slate-100">{t.pronTitle}</p>
        <span className="text-xs text-slate-500">{t.optional}</span>
      </div>

      {!expanded ? (
        <div className="px-4 pb-4 space-y-3">
          <p className="text-sm text-slate-400 leading-relaxed">{t.pronCardHint}</p>
          {quotaLine && <p className="text-xs text-slate-500">{quotaLine}</p>}
          <button
            onClick={() => setExpanded(true)}
            className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-semibold bg-purple-700 hover:bg-purple-600 text-white transition-colors"
          >
            {t.pronTrain}
            <ChevronRight className="w-4 h-4 shrink-0" strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      ) : (
        <div className="px-4 pb-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-400 font-medium uppercase tracking-wider">{t.pronExpandedTitle}</p>
            <button
              onClick={() => setExpanded(false)}
              aria-label={t.sheetClose}
              className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 transition-colors"
            >
              <ChevronUp className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
          {quotaLine && <p className="text-xs text-slate-500">{quotaLine}</p>}
          <PronunciationRecorder referenceText={referenceText} reviewId={reviewId} />
        </div>
      )}
    </div>
  );
}
