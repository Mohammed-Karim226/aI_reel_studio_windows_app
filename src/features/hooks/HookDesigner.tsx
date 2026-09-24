import { createPopAnimations, hookTemplates } from "@/domain/hook";
import { useTimelineStore } from "@/stores/timelineStore";
import { Button } from "@/shared/ui/Button";

export function HookDesigner() {
  const timeline = useTimelineStore((state) => state.timeline);
  const edit = useTimelineStore((state) => state.edit);
  if (!timeline) return null;
  const hook = timeline.hook;
  return (
    <section className="border-t border-slate-800 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold text-slate-200">Hook designer</h2>
        <label className="flex items-center gap-1 text-[11px] text-slate-400">
          <input
            type="checkbox"
            checked={hook.enabled}
            onChange={(event) => edit({ type: "hook", patch: { enabled: event.target.checked } })}
          />{" "}
          Enabled
        </label>
      </div>
      <div className="mt-2 flex gap-2">
        <select
          aria-label="Hook template"
          className="min-w-0 flex-1 rounded bg-slate-800 p-2"
          defaultValue=""
          onChange={(event) => {
            if (event.target.value)
              edit({ type: "applyHookTemplate", templateId: event.target.value });
          }}
        >
          <option value="">Choose template</option>
          {hookTemplates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.category} · {template.name}
            </option>
          ))}
        </select>
        <Button size="sm" onClick={() => edit({ type: "addHookLayer", role: "main" })}>
          Add text
        </Button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <label className="flex-1">
          Duration
          <input
            key={hook.duration}
            aria-label="Hook duration"
            type="number"
            min="0.1"
            step="0.1"
            defaultValue={hook.duration}
            onBlur={(event) =>
              edit({ type: "hook", patch: { duration: Number(event.target.value) } })
            }
            className="mt-1 w-full rounded bg-slate-800 p-2"
          />
        </label>
        <label className="flex-1">
          Background
          <input
            key={hook.background}
            aria-label="Hook background"
            type="text"
            defaultValue={hook.background}
            onBlur={(event) => edit({ type: "hook", patch: { background: event.target.value } })}
            className="mt-1 w-full rounded bg-slate-800 p-2"
          />
        </label>
      </div>
      <div
        aria-label="Hook mini timeline"
        className="relative mt-3 h-9 overflow-hidden rounded border border-slate-800 bg-slate-950"
      >
        {hook.layers.map((layer) => (
          <div
            key={layer.id}
            className={`absolute inset-y-1 truncate rounded px-1.5 text-[10px] leading-7 ${layer.role === "main" ? "bg-indigo-800" : "bg-amber-800"}`}
            style={{
              left: `${(layer.start / hook.duration) * 100}%`,
              width: `${((layer.end - layer.start) / hook.duration) * 100}%`,
            }}
          >
            {layer.role === "main" ? "Main" : "Secondary"}
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-col gap-3">
        {hook.layers.map((layer) => (
          <div key={layer.id} className="rounded border border-slate-800 bg-slate-900/60 p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-slate-300">
                {layer.role === "main" ? "Main text" : "Secondary text"}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  edit({
                    type: "hookLayer",
                    id: layer.id,
                    patch: { animations: createPopAnimations(layer.start) },
                  })
                }
              >
                Pop
              </Button>
            </div>
            <textarea
              key={layer.text}
              aria-label={`${layer.role} hook text`}
              defaultValue={layer.text}
              onBlur={(event) =>
                edit({ type: "hookLayer", id: layer.id, patch: { text: event.target.value } })
              }
              className="mt-2 min-h-14 w-full resize-y rounded bg-slate-800 p-2"
            />
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label>
                Start
                <input
                  key={layer.start}
                  aria-label={`${layer.role} start`}
                  type="number"
                  min="0"
                  step="0.1"
                  defaultValue={layer.start}
                  onBlur={(event) =>
                    edit({
                      type: "hookLayer",
                      id: layer.id,
                      patch: { start: Number(event.target.value) },
                    })
                  }
                  className="mt-1 w-full rounded bg-slate-800 p-2"
                />
              </label>
              <label>
                End
                <input
                  key={layer.end}
                  aria-label={`${layer.role} end`}
                  type="number"
                  min="0"
                  step="0.1"
                  defaultValue={layer.end}
                  onBlur={(event) =>
                    edit({
                      type: "hookLayer",
                      id: layer.id,
                      patch: { end: Number(event.target.value) },
                    })
                  }
                  className="mt-1 w-full rounded bg-slate-800 p-2"
                />
              </label>
              <label>
                X offset
                <input
                  key={layer.transform.x}
                  aria-label={`${layer.role} X offset`}
                  type="number"
                  step="1"
                  defaultValue={layer.transform.x}
                  onBlur={(event) =>
                    edit({
                      type: "hookLayer",
                      id: layer.id,
                      patch: { transform: { ...layer.transform, x: Number(event.target.value) } },
                    })
                  }
                  className="mt-1 w-full rounded bg-slate-800 p-2"
                />
              </label>
              <label>
                Y offset
                <input
                  key={layer.transform.y}
                  aria-label={`${layer.role} Y offset`}
                  type="number"
                  step="1"
                  defaultValue={layer.transform.y}
                  onBlur={(event) =>
                    edit({
                      type: "hookLayer",
                      id: layer.id,
                      patch: { transform: { ...layer.transform, y: Number(event.target.value) } },
                    })
                  }
                  className="mt-1 w-full rounded bg-slate-800 p-2"
                />
              </label>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={() => edit({ type: "hook", patch: { enabled: true } })}>
          Enable hook
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => edit({ type: "applyHookTemplate", templateId: "bold-question" })}
        >
          Reset template
        </Button>
      </div>
    </section>
  );
}
