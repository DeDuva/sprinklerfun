"use client"

import { useRef, useState } from "react"
import Papa from "papaparse"
import { toast } from "sonner"
import { useStore } from "@/lib/store"
import type { FlumeRow } from "@/lib/types"
import { pushRows } from "@/lib/backend"
import { parseFlumeCsvRows, buildFlumeExportUrl } from "@/lib/csvImport"

export default function RefreshDataCard() {
  const rowCount = useStore((s) => s.rowCount)
  const lastRowDate = useStore((s) => s.lastRowDate)
  const setRowCount = useStore((s) => s.setRowCount)
  const setLastRowDate = useStore((s) => s.setLastRowDate)
  const bumpServerVersion = useStore((s) => s.bumpServerVersion)
  const fileRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)

  async function finish(parsed: FlumeRow[], label: string) {
    if (parsed.length === 0) {
      toast.error("No valid rows found. Expected columns: datetime, gallons")
      return
    }
    setBusy(true)
    const t = toast.loading(`Saving ${parsed.length.toLocaleString()} rows from ${label}…`)
    const r = await pushRows(parsed, useStore.getState().windows)
    toast.dismiss(t)
    setBusy(false)
    if (r.ok) {
      setRowCount(rowCount + (r.inserted ?? 0))
      const maxDate = parsed.reduce((a, b) => (a > b.datetime ? a : b.datetime), "").slice(0, 10)
      if (maxDate && (!lastRowDate || maxDate > lastRowDate)) setLastRowDate(maxDate)
      bumpServerVersion()
      toast.success(`Saved ${(r.inserted ?? 0).toLocaleString()} new rows from ${label}`)
    } else {
      toast.error(`Saving to the server failed: ${r.error}`)
    }
  }

  function processFile(file: File) {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => finish(parseFlumeCsvRows(results.data), file.name),
      error: () => toast.error("Failed to parse CSV"),
    })
  }

  return (
    <div className="rounded-2xl border-2 border-dashed border-[#EADFC6] bg-white/60 p-4 flex items-center gap-4 flex-wrap">
      <a
        href={buildFlumeExportUrl(lastRowDate)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 rounded-full border-2 border-[#143049] bg-[#FBF0DC] px-4 py-2 text-sm font-medium text-[#143049] hover:bg-[#F5E3C0] transition-colors shrink-0"
      >
        🔄 Refresh data
      </a>
      <div
        className={`flex-1 min-w-[220px] rounded-xl border-2 border-dashed px-4 py-2 text-xs text-center cursor-pointer transition-colors ${
          dragging ? "border-sky-500 bg-sky-50" : "border-gray-300 hover:border-gray-400 text-gray-500"
        }`}
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          if (e.dataTransfer.files?.[0]) processFile(e.dataTransfer.files[0])
        }}
      >
        {busy
          ? "Saving…"
          : lastRowDate
            ? <>Opens Flume export in a new tab (from {lastRowDate}) — download the CSV, then drop it here</>
            : <>Opens Flume export in a new tab — download the CSV, then drop it here</>}
        <input
          ref={fileRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && processFile(e.target.files[0])}
        />
      </div>
      {rowCount > 0 && (
        <span className="text-xs text-gray-400 shrink-0">{rowCount.toLocaleString()} rows stored</span>
      )}
    </div>
  )
}
