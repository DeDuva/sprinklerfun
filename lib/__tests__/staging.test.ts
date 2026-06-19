import { describe, it, expect } from "vitest"
import {
  stageKey,
  wouldChange,
  buildStagedChange,
  proposeAllChanges,
  applyStagedChanges,
  programStartStations,
} from "../staging"
import type { AppConfig, SegmentReconciliation } from "../types"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function recon(over: Partial<SegmentReconciliation> & {
  stationId: string
}): SegmentReconciliation {
  const defaults: SegmentReconciliation = {
    stationId: over.stationId,
    name: over.stationId,
    timer: "timer1",
    programId: "A",
    cfgStartMin: 360,
    cfgEndMin: 370,
    cfgDurationMin: 10,
    baselineGpm: 2,
    actualStartMin: 360,
    actualEndMin: 370,
    actualDurationMin: 10,
    actualGpm: 2,
    startDriftMin: 0,
    durationDriftMin: 0,
    gpmDeltaPct: 0,
    confidence: "high",
  }
  return { ...defaults, ...over }
}

function config(): AppConfig {
  return {
    timer1: {
      stations: [
        { id: "T1-01", name: "Front Lawn", baselineGpm: 2 },
        { id: "T1-02", name: "Back Garden", baselineGpm: 3 },
      ],
      programs: {
        A: {
          enabled: true,
          start: "06:00:00",
          days: [0, 2, 4],
          stations: {
            "T1-01": { durationMin: 10, enabled: true },
            "T1-02": { durationMin: 5, enabled: true },
          },
        },
        B: { enabled: false, start: "06:00:00", days: [], stations: {} },
        C: { enabled: false, start: "06:00:00", days: [], stations: {} },
      },
    },
    timer2: {
      stations: [{ id: "T2-01", name: "Side Yard", baselineGpm: 4 }],
      programs: {
        A: { enabled: true, start: "08:00:00", days: [0, 2, 4], stations: { "T2-01": { durationMin: 8, enabled: true } } },
        B: { enabled: false, start: "08:00:00", days: [], stations: {} },
        C: { enabled: false, start: "08:00:00", days: [], stations: {} },
      },
    },
    sprinklerOnThreshold: 50,
    gallonsPerUnit: 748,
    costPerUnit: 10.47,
  }
}

// ---------------------------------------------------------------------------
// stageKey
// ---------------------------------------------------------------------------

describe("stageKey", () => {
  it("keys baseline/duration per station but start per program", () => {
    const r = recon({ stationId: "T1-01" })
    expect(stageKey(r, "baseline")).toBe("timer1:A:T1-01:baseline")
    expect(stageKey(r, "duration")).toBe("timer1:A:T1-01:duration")
    expect(stageKey(r, "start")).toBe("timer1:A:start")
  })

  it("gives two stations in the same program the SAME start key", () => {
    const a = recon({ stationId: "T1-01" })
    const b = recon({ stationId: "T1-02", cfgStartMin: 370 })
    expect(stageKey(a, "start")).toBe(stageKey(b, "start"))
  })
})

// ---------------------------------------------------------------------------
// wouldChange
// ---------------------------------------------------------------------------

describe("wouldChange", () => {
  it("baseline: true only when the rounded actual differs from the baseline", () => {
    expect(wouldChange(recon({ stationId: "x", baselineGpm: 2, actualGpm: 2 }), "baseline")).toBe(false)
    expect(wouldChange(recon({ stationId: "x", baselineGpm: 2, actualGpm: 2.004 }), "baseline")).toBe(false) // rounds to 2.00
    expect(wouldChange(recon({ stationId: "x", baselineGpm: 2, actualGpm: 2.5 }), "baseline")).toBe(true)
    expect(wouldChange(recon({ stationId: "x", baselineGpm: null, actualGpm: 4 }), "baseline")).toBe(true)
    expect(wouldChange(recon({ stationId: "x", actualGpm: null }), "baseline")).toBe(false)
  })

  it("duration: true only when the actual run differs from configured", () => {
    expect(wouldChange(recon({ stationId: "x", cfgDurationMin: 10, actualDurationMin: 10 }), "duration")).toBe(false)
    expect(wouldChange(recon({ stationId: "x", cfgDurationMin: 10, actualDurationMin: 12 }), "duration")).toBe(true)
    expect(wouldChange(recon({ stationId: "x", actualDurationMin: null }), "duration")).toBe(false)
  })

  it("start: true only when there is a non-zero drift", () => {
    expect(wouldChange(recon({ stationId: "x", startDriftMin: 0 }), "start")).toBe(false)
    expect(wouldChange(recon({ stationId: "x", startDriftMin: 3 }), "start")).toBe(true)
    expect(wouldChange(recon({ stationId: "x", startDriftMin: null }), "start")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// buildStagedChange — apply mutates the config correctly
// ---------------------------------------------------------------------------

describe("buildStagedChange", () => {
  it("baseline change sets the station's baselineGpm (rounded to 2dp)", () => {
    const cfg = config()
    const c = buildStagedChange(recon({ stationId: "T1-01", actualGpm: 1.712, baselineGpm: 2 }), "baseline")
    expect(c.fromText).toBe("2.00")
    expect(c.toText).toBe("1.71")
    c.apply(cfg)
    expect(cfg.timer1.stations.find((s) => s.id === "T1-01")!.baselineGpm).toBe(1.71)
  })

  it("duration change sets the program-station durationMin", () => {
    const cfg = config()
    const c = buildStagedChange(recon({ stationId: "T1-01", cfgDurationMin: 10, actualDurationMin: 13 }), "duration")
    expect(c.toText).toBe("13m")
    c.apply(cfg)
    expect(cfg.timer1.programs.A.stations["T1-01"].durationMin).toBe(13)
  })

  it("start change shifts the program start by the drift", () => {
    const cfg = config() // Program A start 06:00
    const c = buildStagedChange(recon({ stationId: "T1-01", cfgStartMin: 360, actualStartMin: 363, startDriftMin: 3 }), "start")
    expect(c.note).toMatch(/\+3m/)
    c.apply(cfg)
    expect(cfg.timer1.programs.A.start).toBe("06:03:00")
  })

  it("negative start drift shifts the program earlier", () => {
    const cfg = config()
    const c = buildStagedChange(recon({ stationId: "T1-01", startDriftMin: -2 }), "start")
    c.apply(cfg)
    expect(cfg.timer1.programs.A.start).toBe("05:58:00")
  })
})

// ---------------------------------------------------------------------------
// programStartStations
// ---------------------------------------------------------------------------

describe("programStartStations", () => {
  it("returns the first (earliest cfg start) station of each program", () => {
    const rows = [
      recon({ stationId: "T1-01", cfgStartMin: 360 }),
      recon({ stationId: "T1-02", cfgStartMin: 370 }),
      recon({ stationId: "T2-01", timer: "timer2", cfgStartMin: 480 }),
    ]
    const set = programStartStations(rows)
    expect(set.has("timer1:A:T1-01")).toBe(true)
    expect(set.has("timer1:A:T1-02")).toBe(false)
    expect(set.has("timer2:A:T2-01")).toBe(true)
  })

  it("is independent of row order", () => {
    const rows = [
      recon({ stationId: "T1-02", cfgStartMin: 370 }),
      recon({ stationId: "T1-01", cfgStartMin: 360 }),
    ]
    expect(programStartStations(rows).has("timer1:A:T1-01")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// proposeAllChanges
// ---------------------------------------------------------------------------

describe("proposeAllChanges", () => {
  it("proposes only changed fields, and one start per program (first station)", () => {
    const rows = [
      // first station: start drifted +2, baseline changed, duration unchanged
      recon({ stationId: "T1-01", cfgStartMin: 360, actualStartMin: 362, startDriftMin: 2, baselineGpm: 2, actualGpm: 1.7, cfgDurationMin: 10, actualDurationMin: 10 }),
      // second station: also drifted, but its start must NOT produce a second proposal
      recon({ stationId: "T1-02", cfgStartMin: 370, actualStartMin: 372, startDriftMin: 2, baselineGpm: 3, actualGpm: 3, cfgDurationMin: 5, actualDurationMin: 7 }),
    ]
    const proposed = proposeAllChanges(rows)
    const keys = proposed.map((c) => c.key).sort()
    expect(keys).toEqual([
      "timer1:A:T1-01:baseline", // T1-01 baseline 2 → 1.7
      "timer1:A:T1-02:duration", // T1-02 duration 5 → 7
      "timer1:A:start",          // single program start (from T1-01)
    ].sort())
    // exactly one start change
    expect(proposed.filter((c) => c.key.endsWith(":start")).length).toBe(1)
  })

  it("returns nothing when actuals already match config", () => {
    const rows = [recon({ stationId: "T1-01", startDriftMin: 0, actualGpm: 2, baselineGpm: 2, actualDurationMin: 10, cfgDurationMin: 10 })]
    expect(proposeAllChanges(rows)).toEqual([])
  })

  it("skips rows with no detected run", () => {
    const rows = [recon({ stationId: "T1-01", actualStartMin: null, actualEndMin: null, actualDurationMin: null, actualGpm: null, startDriftMin: null })]
    expect(proposeAllChanges(rows)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// applyStagedChanges — pure, composes, leaves input untouched
// ---------------------------------------------------------------------------

describe("applyStagedChanges", () => {
  it("applies every staged change to a fresh config without mutating the input", () => {
    const cfg = config()
    const changes = [
      buildStagedChange(recon({ stationId: "T1-01", baselineGpm: 2, actualGpm: 1.71 }), "baseline"),
      buildStagedChange(recon({ stationId: "T1-02", cfgDurationMin: 5, actualDurationMin: 7 }), "duration"),
      buildStagedChange(recon({ stationId: "T1-01", startDriftMin: 3 }), "start"),
    ]
    const next = applyStagedChanges(cfg, changes)

    // input untouched
    expect(cfg.timer1.stations.find((s) => s.id === "T1-01")!.baselineGpm).toBe(2)
    expect(cfg.timer1.programs.A.start).toBe("06:00:00")

    // output has all three changes
    expect(next.timer1.stations.find((s) => s.id === "T1-01")!.baselineGpm).toBe(1.71)
    expect(next.timer1.programs.A.stations["T1-02"].durationMin).toBe(7)
    expect(next.timer1.programs.A.start).toBe("06:03:00")
  })

  it("an end-to-end proposeAll → apply reconciles the config to the day's actuals", () => {
    const cfg = config()
    const rows = [
      recon({ stationId: "T1-01", cfgStartMin: 360, actualStartMin: 364, startDriftMin: 4, baselineGpm: 2, actualGpm: 2.6, cfgDurationMin: 10, actualDurationMin: 12 }),
    ]
    const next = applyStagedChanges(cfg, proposeAllChanges(rows))
    expect(next.timer1.programs.A.start).toBe("06:04:00")
    expect(next.timer1.stations.find((s) => s.id === "T1-01")!.baselineGpm).toBe(2.6)
    expect(next.timer1.programs.A.stations["T1-01"].durationMin).toBe(12)
  })
})
