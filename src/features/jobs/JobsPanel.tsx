import { derivativeKindSchema, type DerivativeKind } from "@/domain/media";
import { isActiveJob, type JobSnapshot, type JobStatus } from "@/domain/jobs";
import { Button } from "@/shared/ui/Button";
import { Pill } from "@/shared/ui/Pill";
import { ProgressBar } from "@/shared/ui/ProgressBar";
import { useJobsStore } from "@/stores/jobsStore";
import { useMediaStore } from "@/stores/mediaStore";

export function JobsPanel() {
  const jobs = useJobsStore((state) => state.jobs);
  const cancel = useJobsStore((state) => state.cancel);
  const clearFinished = useJobsStore((state) => state.clearFinished);
  const regenerate = useMediaStore((state) => state.regenerate);

  const active = jobs.filter(isActiveJob).length;

  return (
    <section className="shrink-0 border-t border-slate-800 bg-slate-900/60">
      <header className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Jobs</h2>
          {active > 0 && <Pill tone="info">{active} active</Pill>}
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void clearFinished()}
          disabled={jobs.length === 0}
        >
          Clear finished
        </Button>
      </header>

      <div className="max-h-44 overflow-y-auto border-t border-slate-800/70">
        {jobs.length === 0 ? (
          <p className="px-3 py-4 text-xs text-slate-500">
            Background work (proxies, thumbnails, waveforms) appears here.
          </p>
        ) : (
          <ul className="divide-y divide-slate-800/70">
            {jobs.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                onCancel={() => void cancel(job.id)}
                onRetry={() => {
                  const kind = derivativeKindOf(job);
                  if (kind && job.mediaAssetId) {
                    void regenerate(job.mediaAssetId, kind);
                  }
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

interface JobRowProps {
  job: JobSnapshot;
  onCancel: () => void;
  onRetry: () => void;
}

function JobRow({ job, onCancel, onRetry }: JobRowProps) {
  const retryable = derivativeKindOf(job) !== null && job.mediaAssetId !== null;
  const terminal =
    job.status === "failed" || job.status === "skipped" || job.status === "cancelled";

  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs text-slate-200">{job.label}</span>
          <StatusPill status={job.status} />
        </div>

        <div className="mt-1.5">
          <ProgressBar
            value={
              job.status === "completed" || job.status === "skipped"
                ? 1
                : job.status === "running"
                  ? (job.progress ?? null)
                  : 0
            }
          />
        </div>

        {job.error && <p className="mt-1 text-[11px] text-rose-300">{job.error.message}</p>}
        {!job.error && job.message && (
          <p className="mt-1 text-[11px] text-slate-500">{job.message}</p>
        )}
      </div>

      <div className="flex shrink-0 gap-1">
        {isActiveJob(job) && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        {terminal && retryable && (
          <Button size="sm" variant="ghost" onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
    </li>
  );
}

function StatusPill({ status }: { status: JobStatus }) {
  switch (status) {
    case "completed":
      return <Pill tone="good">done</Pill>;
    case "running":
      return <Pill tone="info">running</Pill>;
    case "queued":
      return <Pill tone="warn">queued</Pill>;
    case "skipped":
      return <Pill tone="neutral">skipped</Pill>;
    case "cancelled":
      return <Pill tone="neutral">cancelled</Pill>;
    case "failed":
      return <Pill tone="bad">failed</Pill>;
  }
}

function derivativeKindOf(job: JobSnapshot): DerivativeKind | null {
  const parsed = derivativeKindSchema.safeParse(job.kind);
  return parsed.success ? parsed.data : null;
}
