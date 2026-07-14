import type { LucideIcon } from 'lucide-react';

interface AppIconProps {
  icon: LucideIcon;
  className?: string;
}

export function AppIcon({ icon: Icon, className = 'w-5 h-5 shrink-0' }: AppIconProps) {
  return <Icon className={className} strokeWidth={2} aria-hidden="true" />;
}
