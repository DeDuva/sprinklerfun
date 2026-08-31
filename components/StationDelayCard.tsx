"use client"

import type { DelayRecommendation } from "@/lib/types"

// One timer's inferred inter-station delay.
//
// The card's job is to keep two numbers side by side. A program that overruns
// does so for two different reasons — dead time the controller inserts between
// stations, and stations simply running longer than configured — and they need
// opposite fixes. Showing only the delay invites the residual to be corrected by
// inflating run times, which over-waters; showing only the drift is what the app
// did before, and it hid a hardware setting inside eleven duration edits. So the
// split is always stated, even when one side is zero.

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex justify-between gap-4 text-xs">
      <span className="text-gray-500">{label}</span>
      <span className={muted ? "text-gray-400" : "text-[#143049] font-medium tabular-nums"}>{value}</span>
    </div>
  )
}

function TimerBlock({
  rec,
  staged,
  onToggle,
}: {
  rec: DelayRecommendation
  staged: boolean
  onToggle: () => void
}) {
  const label = rec.timer === "timer1" ? "Timer 1" : "Timer 2"
  const detected = rec.delaySec != null
  const changes = detected && rec.delaySec !== rec.configuredSec
  const residual = rec.medianResidualMin != null ? Math.round(rec.medianResidualMin) : 0
  const elongation = rec.medianElongationMin != null ? Math.round(rec.medianElongationMin) : 0

  return (
    <div className="rounded-xl border-2 border-[#EADFC6] bg-white/60 p-4 space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-semibold text-[#143049]">{label}</span>
        <span className="text-lg font-semibold tabular-nums text-[#143049]">
          {detected ? `${rec.delaySec}s` : "—"}
        </span>
      </div>

      {detected ? (
        <>
          <Row label="Currently configured" value={`${rec.configuredSec}s`} />
          <Row
            label="Days fitted"
            value={
              rec.minSec === rec.maxSec
                ? `${rec.daysFit} of ${rec.daysTotal}`
                : `${rec.daysFit} of ${rec.daysTotal} · ${rec.minSec}–${rec.maxSec}s`
            }
          />
          <Row label="Program overruns by" value={`${elongation} min`} />
          <Row
            label="Delay explains"
            value={`${rec.medianExplainedMin != null ? Math.round(rec.medianExplainedMin) : 0} min`}
          />
          <Row
            label="Duration drift remains"
            value={`${residual} min`}
            muted={residual <= 1}
          />
        </>
      ) : (
        <Row label="Days examined" value={String(rec.daysTotal)} />
      )}

      <p className="text-xs text-gray-500 pt-1 leading-relaxed">{rec.reason}</p>

      {residual > 1 && (
        <p className="text-xs text-[#8A5A12] leading-relaxed">
          Fix the delay first — the reconciliation below reads the remaining drift
          correctly only once the schedule is aligned.
        </p>
      )}

      {changes ? (
        <button
          onClick={onToggle}
          className={
            "mt-1 w-full text-xs px-3 py-1.5 rounded-lg border-2 transition-colors " +
            (staged
              ? "border-[#143049] bg-[#FFC24B] text-[#143049] font-medium"
              : "border-[#143049]/30 text-[#143049] hover:border-[#143049] hover:bg-[#FBF0DC]")
          }
        >
          {staged ? "✓ Proposed — review to save" : `Propose ${rec.configuredSec}s → ${rec.delaySec}s`}
        </button>
      ) : (
        <p className="text-xs text-gray-400 pt-1">
          {detected ? "Config already matches — nothing to propose." : "Nothing to propose."}
        </p>
      )}
    </div>
  )
}

export default function StationDelayCard({
  recommendations,
  loading,
  isStaged,
  onToggle,
}: {
  recommendations: DelayRecommendation[] | null
  loading: boolean
  isStaged: (timer: "timer1" | "timer2") => boolean
  onToggle: (rec: DelayRecommendation) => void
}) {
  if (loading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="h-56 rounded-xl bg-gray-100 animate-pulse" />
        <div className="h-56 rounded-xl bg-gray-100 animate-pulse" />
      </div>
    )
  }

  if (!recommendations || recommendations.length === 0) {
    return (
      <p className="text-sm text-gray-500">
        Not enough sprinkler days yet to infer a delay.
      </p>
    )
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {recommendations.map((rec) => (
        <TimerBlock
          key={rec.timer}
          rec={rec}
          staged={isStaged(rec.timer)}
          onToggle={() => onToggle(rec)}
        />
      ))}
    </div>
  )
}
