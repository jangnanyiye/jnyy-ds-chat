import { Sparkles } from 'lucide-react';

export function Logo({ size = 36, className = '' }: { size?: number; className?: string }) {
  return (
    <span
      className={`brand-mark ${className}`.trim()}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <Sparkles size={Math.round(size * 0.55)} strokeWidth={2.2} />
    </span>
  );
}
