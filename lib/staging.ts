import type { AppConfig, SegmentReconciliation } from "./types"

// ---------------------------------------------------------------------------
// Staged config edits — the pure core behind the Analysis tab's
// "propose → review → save" flow. No React here: build a change from a
// reconciliation row, decide whether it's a no-op, and apply a set of staged
// changes to a config (returning a fresh copy). The page holds the staged Map
// and renders; all the logic that decides *what* a change does lives here.
// ---------------------------------------------------------------------------

export type StageKind = "baseline" | "start" | "duration"

export interface StagedChange {
  key: string
  area: string        // grouping label, e.g. "T1 · Program A"
  field: string       // e.g. "Front Lawn baseline gpm"
  fromText: string
  toText: string
  note?: string
  apply: (cfg: AppConfig) => void // mutates the config in place
}

const deepClone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

export function minToTime(min: number): string {
  const clamped = Math.max(0, Math.min(1439, Math.round(min)))
  const h = Math.floor(clamped / 60)
  const m = clamped % 60
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`
}

export function parseTime(t: string): number {
  const [h, m] = t.split(":").map(Number)
  return h * 60 + m
}

function fmtHM(min: number | null): string {
  if (min == null) return "—"
  const h = Math.floor(min / 60) % 24
  const m = ((min % 60) + 60) % 60
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}

function findStation(cfg: AppConfig, timer: "timer1" | "timer2", id: string) {
  return cfg[timer].stations.find((s) => s.id === id)
}

/**
 * Stable key for a staged change. The program start is a single shared knob, so
 * start changes are keyed per program (last write wins); baseline and duration
 * are per station.
 */
export function stageKey(r: SegmentReconciliation, kind: StageKind): string {
  return kind === "start"
    ? `${r.timer}:${r.programId}:start`
    : `${r.timer}:${r.programId}:${r.stationId}:${kind}`
}

/** Round a gpm value the way a staged baseline change does (2 dp). */
const round2 = (n: number) => +n.toFixed(2)

/**
 * Whether staging this change would actually alter the config. Used to disable
 * no-op buttons and to filter "stage all". False when the relevant actual is
 * missing or already matches the configured value.
 */
export function wouldChange(r: SegmentReconciliation, kind: StageKind): boolean {
  if (kind === "baseline") {
    return r.actualGpm != null && (r.baselineGpm == null || round2(r.actualGpm) !== round2(r.baselineGpm))
  }
  if (kind === "duration") {
    return r.actualDurationMin != null && r.actualDurationMin !== r.cfgDurationMin
  }
  // start
  return r.startDriftMin != null && r.startDriftMin !== 0
}

/** Build a staged change (with its `apply` mutator) from a reconciliation row. */
export function buildStagedChange(r: SegmentReconciliation, kind: StageKind): StagedChange {
  const area = `${r.timer === "timer1" ? "T1" : "T2"} · Program ${r.programId}`

  if (kind === "baseline") {
    const to = round2(r.actualGpm as number)
    return {
      key: stageKey(r, kind),
      area,
      field: `${r.name} baseline gpm`,
      fromText: r.baselineGpm != null ? r.baselineGpm.toFixed(2) : "—",
      toText: to.toFixed(2),
      apply: (cfg) => {
        const st = findStation(cfg, r.timer, r.stationId)
        if (st) st.baselineGpm = to
      },
    }
  }

  if (kind === "duration") {
    const to = r.actualDurationMin as number
    return {
      key: stageKey(r, kind),
      area,
      field: `${r.name} duration`,
      fromText: `${r.cfgDurationMin}m`,
      toText: `${to}m`,
      apply: (cfg) => {
        const ps = cfg[r.timer].programs[r.programId].stations[r.stationId]
        if (ps) ps.durationMin = to
      },
    }
  }

  // start — shifts the whole program by the detected drift
  const drift = r.startDriftMin as number
  return {
    key: stageKey(r, kind),
    area,
    field: `Program ${r.programId} start`,
    fromText: fmtHM(r.cfgStartMin),
    toText: fmtHM(r.actualStartMin),
    note: `shifts program ${drift >= 0 ? "+" : ""}${drift}m`,
    apply: (cfg) => {
      const p = cfg[r.timer].programs[r.programId]
      p.start = minToTime(parseTime(p.start) + drift)
    },
  }
}

/**
 * The set of `${timer}:${programId}:${stationId}` keys that are the FIRST station
 * (lowest configured start) of their program. The program-start proposal is only
 * meaningful here — downstream stations inherit the program start plus upstream
 * durations, so their drift should be corrected via duration, not start.
 */
export function programStartStations(recon: SegmentReconciliation[]): Set<string> {
  const byProgram = new Map<string, SegmentReconciliation>()
  for (const r of recon) {
    const k = `${r.timer}:${r.programId}`
    const cur = byProgram.get(k)
    if (!cur || r.cfgStartMin < cur.cfgStartMin) byProgram.set(k, r)
  }
  const set = new Set<string>()
  for (const r of byProgram.values()) set.add(`${r.timer}:${r.programId}:${r.stationId}`)
  return set
}

/**
 * Propose every meaningful change for a day's reconciliation: every station's
 * baseline and duration that differs, plus each program's start (taken from its
 * first station). Returns a de-duplicated array (one entry per stageKey).
 */
export function proposeAllChanges(recon: SegmentReconciliation[]): StagedChange[] {
  const out = new Map<string, StagedChange>()
  const startStations = programStartStations(recon)

  for (const r of recon) {
    if (wouldChange(r, "baseline")) {
      const c = buildStagedChange(r, "baseline")
      out.set(c.key, c)
    }
    if (wouldChange(r, "duration")) {
      const c = buildStagedChange(r, "duration")
      out.set(c.key, c)
    }
  }
  for (const r of recon) {
    if (startStations.has(`${r.timer}:${r.programId}:${r.stationId}`) && wouldChange(r, "start")) {
      const c = buildStagedChange(r, "start")
      out.set(c.key, c)
    }
  }
  return [...out.values()]
}

/**
 * Apply a set of staged changes to a config, returning a fresh (deep-cloned)
 * config. The input is left untouched. Each change's `apply` mutates the clone;
 * since start changes are keyed per program, a well-formed staged set never
 * double-shifts a program start.
 */
export function applyStagedChanges(config: AppConfig, changes: Iterable<StagedChange>): AppConfig {
  const next = deepClone(config)
  for (const c of changes) c.apply(next)
  return next
}
