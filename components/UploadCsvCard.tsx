"use client"

import { useRef, useState } from "react"
import { toast } from "sonner"
import { useStore } from "@/lib/store"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { buildFlumeExportUrl } from "@/lib/csvImport"
import { useCsvUpload } from "@/lib/useCsvUpload"

// The manual CSV uploader: file drop / picker + load-from-URL. Extracted from the
// Config page so it can also serve as the hidden fallback on the Settings page.
export default function UploadCsvCard() {
  const rowCount = useStore((s) => s.rowCount)
  const lastRowDate = useStore((s) => s.lastRowDate)
  const { uploadFile, uploadText } = useCsvUpload()
  const fileRef = useRef<HTMLInputElement>(null)
  const [urlInput, setUrlInput] = useState("")
  const [loadingUrl, setLoadingUrl] = useState(false)
  const [dragging, setDragging] = useState(false)

  async function loadFromUrl() {
    if (!urlInput.trim()) return
    setLoadingUrl(true)
    const rawUrl = urlInput
      .replace("https://github.com/", "https://raw.githubusercontent.com/")
      .replace("/blob/", "/")
    try {
      const res = await fetch(rawUrl)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      uploadText(text, rawUrl.split("/").pop() ?? "URL")
      setUrlInput("")
    } catch (e) {
      toast.error(`Could not fetch URL: ${e instanceof Error ? e.message : e}`)
    } finally {
      setLoadingUrl(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-base">
            Upload CSV Data
            <span className="ml-2 text-xs font-normal text-gray-400">
              {rowCount.toLocaleString()} rows stored
            </span>
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="text-sm">
            <span className="font-medium text-gray-700">1.</span>{" "}
            <a
              href={buildFlumeExportUrl(lastRowDate)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-600 hover:text-sky-700 underline underline-offset-2"
            >
              Open Flume export →
            </a>
            <span className="text-xs text-gray-400 ml-2">
              {lastRowDate ? `from ${lastRowDate}` : "full range"}
            </span>
          </div>
          <span className="text-sm text-gray-400">
            <span className="font-medium text-gray-700">2.</span> Download CSV, then drop it below
          </span>
        </div>

        <div
          className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
            dragging ? "border-sky-500 bg-sky-50" : "border-gray-300 hover:border-gray-400"
          }`}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            if (e.dataTransfer.files?.[0]) uploadFile(e.dataTransfer.files[0])
          }}
        >
          <p className="text-gray-600 font-medium">Drop CSV here or click to browse</p>
          <p className="text-xs text-gray-400 mt-1">New rows are merged with existing data. Duplicates are skipped.</p>
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && uploadFile(e.target.files[0])}
          />
        </div>

        <div>
          <p className="text-sm font-medium mb-1">Load from URL</p>
          <p className="text-xs text-gray-400 mb-1.5">GitHub blob URLs are converted to raw automatically.</p>
          <div className="flex gap-2">
            <Input
              placeholder="https://github.com/user/repo/blob/main/data.csv"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && loadFromUrl()}
              className="text-sm h-8"
            />
            <Button size="sm" className="h-8 shrink-0" onClick={loadFromUrl} disabled={loadingUrl || !urlInput.trim()}>
              {loadingUrl ? "Loading…" : "Load"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
