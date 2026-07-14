"use client"

import { useCallback, useRef, useState } from "react"
import Papa from "papaparse"
import { toast } from "sonner"
import { useStore } from "@/lib/store"
import type { FlumeRow } from "@/lib/types"
import { pushRows } from "@/lib/backend"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

interface Props {
  open: boolean
  onClose: () => void
}

function parseRows(data: Record<string, string>[]): FlumeRow[] {
  const rows: FlumeRow[] = []
  for (const row of data) {
    const dt = row["datetime"] ?? row["Datetime"] ?? row["DateTime"]
    const g = parseFloat(row["gallons"] ?? row["Gallons"] ?? "0")
    if (dt && !isNaN(g)) rows.push({ datetime: dt.trim(), gallons: g })
  }
  return rows
}

export default function UploadModal({ open, onClose }: Props) {
  const [dragging, setDragging] = useState(false)
  const [url, setUrl] = useState("")
  const [loadingUrl, setLoadingUrl] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const finish = useCallback(
    (rows: FlumeRow[], label: string) => {
      if (rows.length === 0) {
        toast.error("No valid rows found. Expected columns: datetime, gallons")
        return
      }
      onClose()
      // Persist durably to the server — it ingests the rows and recomputes
      // rollups + stats. Bump serverVersion so the pages refetch their views.
      const state = useStore.getState()
      pushRows(rows, state.windows).then((r) => {
        if (!r.ok) {
          toast.error(`Saving to the server failed: ${r.error}`)
          return
        }
        state.setRowCount(state.rowCount + (r.inserted ?? 0))
        const maxDate = rows.reduce((a, b) => (a > b.datetime ? a : b.datetime), "").slice(0, 10)
        if (maxDate && (!state.lastRowDate || maxDate > state.lastRowDate)) state.setLastRowDate(maxDate)
        state.bumpServerVersion()
        toast.success(`Saved ${(r.inserted ?? 0).toLocaleString()} new rows from ${label}`)
      })
    },
    [onClose]
  )

  const processFile = useCallback(
    (file: File) => {
      Papa.parse<Record<string, string>>(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => finish(parseRows(results.data), file.name),
        error: () => toast.error("Failed to parse CSV"),
      })
    },
    [finish]
  )

  const loadUrl = async () => {
    if (!url.trim()) return
    setLoadingUrl(true)

    // Convert GitHub blob URLs to raw URLs automatically
    const rawUrl = url
      .replace("https://github.com/", "https://raw.githubusercontent.com/")
      .replace("/blob/", "/")

    try {
      const res = await fetch(rawUrl)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      Papa.parse<Record<string, string>>(text, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => finish(parseRows(results.data), rawUrl.split("/").pop() ?? "URL"),
        error: () => toast.error("Failed to parse CSV"),
      })
    } catch (e) {
      toast.error(`Could not fetch URL: ${e instanceof Error ? e.message : e}`)
    } finally {
      setLoadingUrl(false)
    }
  }

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return
    processFile(files[0])
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md space-y-5">
        <div>
          <h2 className="text-xl font-semibold">Load Flume CSV</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            New rows are merged with existing data. Duplicates are skipped.
          </p>
        </div>

        {/* URL loader */}
        <div className="space-y-1.5">
          <Label className="text-sm">Load from URL</Label>
          <p className="text-xs text-gray-400">
            GitHub blob URLs are converted to raw automatically.
          </p>
          <div className="flex gap-2">
            <Input
              placeholder="https://github.com/user/repo/blob/main/data.csv"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && loadUrl()}
              className="text-sm h-8"
            />
            <Button
              size="sm"
              className="h-8 shrink-0"
              onClick={loadUrl}
              disabled={loadingUrl || !url.trim()}
            >
              {loadingUrl ? "Loading…" : "Load"}
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs text-gray-400">
          <div className="flex-1 h-px bg-gray-200" />
          or upload a file
          <div className="flex-1 h-px bg-gray-200" />
        </div>

        {/* File drop */}
        <div
          className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
            dragging ? "border-blue-500 bg-blue-50" : "border-gray-300 hover:border-gray-400"
          }`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            handleFiles(e.dataTransfer.files)
          }}
        >
          <p className="text-gray-600 font-medium">Drop CSV here</p>
          <p className="text-sm text-gray-400 mt-1">or click to browse</p>
          <input
            ref={inputRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>

        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  )
}
