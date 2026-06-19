"use client"

import { Button } from "@/components/ui/button"

export interface StagedItem {
  key: string
  area: string      // e.g. "T1 · Program A"
  field: string     // e.g. "Front Lawn baseline"
  fromText: string
  toText: string
  note?: string
}

interface Props {
  open: boolean
  windowDateLabel: string | null
  items: StagedItem[]
  onRemove: (key: string) => void
  onSave: () => void
  onCancel: () => void
}

export default function ReviewChangesModal({
  open,
  windowDateLabel,
  items,
  onRemove,
  onSave,
  onCancel,
}: Props) {
  if (!open) return null

  // Group by area for readability.
  const byArea = new Map<string, StagedItem[]>()
  for (const it of items) {
    if (!byArea.has(it.area)) byArea.set(it.area, [])
    byArea.get(it.area)!.push(it)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onCancel}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 pb-3">
          <h2 className="text-xl font-semibold">Review config changes</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            {items.length} change{items.length !== 1 ? "s" : ""} will be written to the config window
            {windowDateLabel ? ` effective ${windowDateLabel}` : ""}. Nothing is saved until you click
            <span className="font-medium text-gray-700"> Save to config</span>.
          </p>
        </div>

        <div className="px-6 overflow-y-auto flex-1 space-y-4">
          {items.length === 0 ? (
            <p className="text-sm text-gray-400 py-6 text-center">No changes staged.</p>
          ) : (
            [...byArea.entries()].map(([area, group]) => (
              <div key={area}>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">{area}</p>
                <div className="space-y-1.5">
                  {group.map((it) => (
                    <div
                      key={it.key}
                      className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="text-sm text-gray-800">{it.field}</p>
                        <p className="text-xs">
                          <span className="text-gray-400 line-through">{it.fromText}</span>
                          <span className="mx-1.5 text-gray-400">→</span>
                          <span className="font-semibold text-blue-600">{it.toText}</span>
                          {it.note && <span className="ml-2 text-gray-400">· {it.note}</span>}
                        </p>
                      </div>
                      <button
                        onClick={() => onRemove(it.key)}
                        title="Remove this change from the proposal"
                        className="shrink-0 text-xs text-gray-400 hover:text-red-500 px-1.5 py-0.5 rounded transition-colors"
                      >
                        remove
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="p-6 pt-4 flex justify-end gap-2 border-t border-gray-100 mt-2">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button onClick={onSave} disabled={items.length === 0}>
            Save to config
          </Button>
        </div>
      </div>
    </div>
  )
}
