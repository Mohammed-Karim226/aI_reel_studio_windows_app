import { cn } from "@/shared/cn";

interface ProgressBarProps {
  /** `0..=1`, or `null` while the duration is unknown (indeterminate). */
  value: number | null;
  className?: string;
}

export function ProgressBar({ value, className }: ProgressBarProps) {
  if (value === null) {
    return (
      <div
        className={cn("h-1.5 w-full overflow-hidden rounded-full bg-slate-800", className)}
        role="progressbar"
        aria-valuetext="working"
      >
        <div className="h-full w-1/3 animate-pulse rounded-full bg-indigo-400" />
      </div>
    );
  }

  const percent = Math.round(Math.min(Math.max(value, 0), 1) * 100);
  return (
    <div
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-slate-800", className)}
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full bg-indigo-400 transition-[width] duration-200"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
