/** Per-activity accent classes, shared by the recommended hero and the compact
 *  practice rows so an activity's colour is defined in exactly one place. */
export const ACCENTS = {
  blue:    { grad: 'from-blue-500 to-blue-700',     shadow: 'shadow-blue-900/40',    ring: 'focus-visible:ring-blue-500',    text: 'text-blue-300',    heroBg: 'from-blue-600/20 to-blue-500/5',       heroBorder: 'border-blue-500/50' },
  teal:    { grad: 'from-teal-500 to-teal-700',     shadow: 'shadow-teal-900/40',    ring: 'focus-visible:ring-teal-500',    text: 'text-teal-300',    heroBg: 'from-teal-600/20 to-teal-500/5',       heroBorder: 'border-teal-500/50' },
  purple:  { grad: 'from-purple-500 to-purple-700', shadow: 'shadow-purple-900/40',  ring: 'focus-visible:ring-purple-500',  text: 'text-purple-300',  heroBg: 'from-purple-600/20 to-purple-500/5',   heroBorder: 'border-purple-500/50' },
  orange:  { grad: 'from-orange-500 to-orange-700', shadow: 'shadow-orange-900/40',  ring: 'focus-visible:ring-orange-500',  text: 'text-orange-300',  heroBg: 'from-orange-600/20 to-orange-500/5',   heroBorder: 'border-orange-500/50' },
  emerald: { grad: 'from-emerald-500 to-emerald-700', shadow: 'shadow-emerald-900/40', ring: 'focus-visible:ring-emerald-500', text: 'text-emerald-300', heroBg: 'from-emerald-600/20 to-emerald-500/5', heroBorder: 'border-emerald-500/50' },
} as const;

export type AccentKey = keyof typeof ACCENTS;
