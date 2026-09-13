"use client"

import { useState } from "react"
import Papa from "papaparse"
import { toast } from "sonner"
import { useStore } from "@/lib/store"
import { pushRows } from "@/lib/backend"
import { parseFlumeCsvRows } from "@/lib/csvImport"
import type { FlumeRow } from "@/lib/types"

// ---------------------------------------------------------------------------
// Shared "parse CSV → POST to server → toast + update store" flow. Previously
// duplicated in RefreshDataCard and the Config page uploader (and a dead modal).
// Callers own their own dropzone/markup; this owns the ingest side effects.
// ---------------------------------------------------------------------------
export function useCsvUpload() {
  const [busy, setBusy] = useState(false)

  async function uploadRows(parsed: FlumeRow[], label: string) {
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
      const s = useStore.getState()
      s.setRowCount(s.rowCount + (r.inserted ?? 0))
      const maxDate = parsed.reduce((a, b) => (a > b.datetime ? a : b.datetime), "").slice(0, 10)
      if (maxDate && (!s.lastRowDate || maxDate > s.lastRowDate)) s.setLastRowDate(maxDate)
      s.bumpServerVersion()
      toast.success(`Saved ${(r.inserted ?? 0).toLocaleString()} new rows from ${label}`)
    } else {
      toast.error(`Saving to the server failed: ${r.error}`)
    }
  }

  function uploadFile(file: File) {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => uploadRows(parseFlumeCsvRows(results.data), file.name),
      error: () => toast.error("Failed to parse CSV"),
    })
  }

  function uploadText(text: string, label: string) {
    Papa.parse<Record<string, string>>(text, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => uploadRows(parseFlumeCsvRows(results.data), label),
      error: () => toast.error("Failed to parse CSV"),
    })
  }

  return { busy, uploadFile, uploadText, uploadRows }
}
