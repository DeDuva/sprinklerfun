import type { Metadata } from "next"
import Link from "next/link"
import { Fredoka } from "next/font/google"
import Flo from "@/components/design/Flo"

const fredoka = Fredoka({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-fredoka",
})

export const metadata: Metadata = {
  title: "SprinklerFun — Sunwater Design System",
  description:
    "The design language of SprinklerFun: meet Flo, the Sunwater palette, and the reimagined dashboard, config, and shareable yard reports.",
}

/* ------------------------------------------------------------------ */
/*  Scoped styles — the whole page lives under `.sf` so nothing here    */
/*  leaks into the real (grayscale) app theme.                          */
/* ------------------------------------------------------------------ */
const css = `
.sf {
  --ink: #143049;
  --ink-soft: #4a6076;
  --cream: #FFF8EC;
  --cream-2: #FBF0DC;
  --panel: #ffffff;
  --mist: #EAF6FC;
  --sky: #35A7E4;
  --sky-deep: #1B6FA8;
  --grass: #4FB05A;
  --grass-deep: #2E7D4F;
  --sun: #FFC24B;
  --sun-deep: #FF9F3E;
  --coral: #FF6B5C;
  --line: #EADFC6;
  color: var(--ink);
  font-family: var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif;
  line-height: 1.55;
}
.sf ::selection { background: #FFDD8A; color: var(--ink); }
.sf h1,.sf h2,.sf h3,.sf .disp { font-family: var(--font-fredoka), ui-rounded, system-ui, sans-serif; letter-spacing: -0.01em; }
.sf .num { font-family: var(--font-geist-mono), ui-monospace, monospace; font-variant-numeric: tabular-nums; }

.sf .wrap { max-width: 1120px; margin: 0 auto; padding: 0 20px; }
.sf .eyebrow { text-transform: uppercase; letter-spacing: .16em; font-size: 12px; font-weight: 700; color: var(--sky-deep); }
.sf .lead { font-size: clamp(17px, 1.4vw, 20px); color: var(--ink-soft); }

/* section shell */
.sf section { padding: clamp(56px, 8vw, 104px) 0; position: relative; }
.sf .sec-head { max-width: 640px; margin-bottom: 40px; }
.sf .sec-head h2 { font-size: clamp(28px, 4vw, 42px); font-weight: 600; margin: 10px 0 12px; line-height: 1.08; }

/* cards */
.sf .card { background: var(--panel); border: 2px solid var(--ink); border-radius: 22px; box-shadow: 6px 6px 0 rgba(20,48,73,.08); }
.sf .soft { border: 1px solid var(--line); border-radius: 18px; background: var(--panel); box-shadow: 0 8px 24px -18px rgba(20,48,73,.5); }
.sf .chip { display:inline-flex; align-items:center; gap:8px; font-weight:600; font-size:13px; padding:6px 12px; border-radius:999px; border:1.5px solid var(--ink); background:#fff; }

.sf .grid { display: grid; gap: 20px; }
.sf .cols2 { display:grid; gap:20px; grid-template-columns: 1fr 1fr; }
.sf .cols-type { display:grid; gap:24px; grid-template-columns: 1.1fr .9fr; align-items:start; }
.sf .cols-report { display:grid; gap:20px; grid-template-columns: 1fr 300px; align-items:start; }
@media (max-width: 760px) {
  .sf .cols2, .sf .cols-type, .sf .cols-report { grid-template-columns: 1fr; }
  .sf table.tone td { display:block; width:auto !important; }
  .sf table.tone td:empty { display:none; }
}
.sf .btn { display:inline-flex; align-items:center; gap:8px; font-family: var(--font-fredoka); font-weight:600; font-size:15px; padding:12px 20px; border-radius:14px; border:2px solid var(--ink); background: var(--sun); color: var(--ink); box-shadow: 3px 3px 0 var(--ink); text-decoration:none; }
.sf .btn.ghost { background:#fff; }
.sf .btn.sky { background: var(--sky); color:#fff; }

/* keyframes */
@keyframes floBob { 0%,100% { transform: translateY(0) rotate(-1.5deg); } 50% { transform: translateY(-9px) rotate(1.5deg); } }
@keyframes floWave { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(24deg); } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes ripple { 0% { transform: scale(.4); opacity:.6 } 100% { transform: scale(1.6); opacity:0 } }
@keyframes spray { 0% { transform: translateY(0) scale(1); opacity:0 } 20%{opacity:.9} 100% { transform: translateY(-46px) scale(.4); opacity:0 } }
@media (prefers-reduced-motion: reduce) { .sf * { animation: none !important; } }

/* hero */
.sf .hero { background:
  radial-gradient(900px 420px at 80% -6%, #FFE9AE 0%, rgba(255,233,174,0) 60%),
  linear-gradient(180deg, #CFEEFB 0%, #EAF6FC 42%, var(--cream) 100%);
  border-bottom: 2px solid var(--ink); overflow: hidden; position: relative; }
.sf .hero-grid { display:grid; grid-template-columns: 1.15fr .85fr; gap:32px; align-items:center; }
.sf .wordmark { font-family: var(--font-fredoka); font-weight:700; font-size: clamp(44px, 8vw, 88px); line-height:.95; letter-spacing:-.03em; }
.sf .wordmark b { color: var(--sky-deep); }
.sf .sun { position:absolute; top:26px; right:6%; width:96px; height:96px; }
.sf .sun .rays { animation: spin 26s linear infinite; transform-origin: 48px 48px; }
.sf .hills { position:absolute; left:0; right:0; bottom:-2px; width:100%; height:120px; }
.sf { overflow-x: clip; }

/* swatches */
.sf .swatch { border-radius:16px; border:2px solid var(--ink); padding:14px; min-height:118px; display:flex; flex-direction:column; justify-content:flex-end; box-shadow: 4px 4px 0 rgba(20,48,73,.12); }
.sf .swatch .nm { font-family: var(--font-fredoka); font-weight:600; font-size:16px; }
.sf .swatch .hx { font-size:12px; opacity:.8; }

/* bars mock */
.sf .bars { display:flex; align-items:flex-end; gap:7px; height:150px; }
.sf .bars .bar { flex:1; border-radius:7px 7px 3px 3px; border:1.5px solid var(--ink); position:relative; }

/* phone */
.sf .phone { width:270px; border:3px solid var(--ink); border-radius:34px; background:var(--cream); padding:12px; box-shadow: 8px 10px 0 rgba(20,48,73,.12); }
.sf .phone .screen { border:2px solid var(--ink); border-radius:24px; overflow:hidden; background:#fff; }
.sf .notch { width:70px; height:6px; border-radius:99px; background:var(--ink); margin:2px auto 10px; opacity:.55; }

.sf .status { display:inline-flex; align-items:center; gap:7px; font-weight:600; font-size:13px; padding:5px 11px; border-radius:999px; }
.sf .dot { width:9px; height:9px; border-radius:99px; display:inline-block; }

.sf table.tone { width:100%; border-collapse:separate; border-spacing:0 10px; }
.sf table.tone td { vertical-align:top; padding:12px 14px; }

.sf a.plain { color: var(--sky-deep); font-weight:600; text-decoration: underline; text-underline-offset:3px; }

@media (max-width: 860px) {
  .sf .hero-grid { grid-template-columns: 1fr; text-align:center; }
  .sf .hero-flo { order:-1; }
  .sf .sun { display:none; }
}
`

/* small helpers ---------------------------------------------------- */
function Swatch({ name, role, hex, fg = "#143049", bg }: { name: string; role: string; hex: string; fg?: string; bg: string }) {
  return (
    <div className="swatch" style={{ background: bg, color: fg }}>
      <div className="nm">{name}</div>
      <div className="hx num">{hex}</div>
      <div style={{ fontSize: 12, marginTop: 4, opacity: 0.9 }}>{role}</div>
    </div>
  )
}

export default function DesignPage() {
  // fabricated but plausible demo data for the mock dashboard
  const week = [
    { d: "M", v: 62, kind: "ok" },
    { d: "T", v: 18, kind: "house" },
    { d: "W", v: 71, kind: "ok" },
    { d: "T", v: 20, kind: "house" },
    { d: "F", v: 96, kind: "leak" },
    { d: "S", v: 22, kind: "house" },
    { d: "S", v: 58, kind: "ok" },
  ]
  const barColor = (k: string) =>
    k === "leak" ? "var(--coral)" : k === "house" ? "var(--mist)" : "var(--sky)"

  return (
    <div className={`sf ${fredoka.variable}`} style={{ margin: "-24px -16px" }}>
      <style dangerouslySetInnerHTML={{ __html: css }} />

      {/* ============================ HERO ============================ */}
      <header className="hero">
        <div className="sun">
          <svg viewBox="0 0 96 96" width="96" height="96">
            <g className="rays">
              {Array.from({ length: 12 }).map((_, i) => (
                <rect key={i} x="46" y="2" width="4" height="16" rx="2" fill="#FF9F3E"
                  transform={`rotate(${i * 30} 48 48)`} />
              ))}
            </g>
            <circle cx="48" cy="48" r="26" fill="#FFC24B" stroke="#143049" strokeWidth="3" />
          </svg>
        </div>

        <div className="wrap" style={{ padding: "clamp(48px,7vw,88px) 20px clamp(90px,10vw,130px)" }}>
          <div className="hero-grid">
            <div>
              <span className="chip" style={{ background: "#fff" }}>💧 Sunwater — Design System v2</span>
              <h1 className="wordmark" style={{ marginTop: 22 }}>
                Sprinkler<b>Fun</b>
              </h1>
              <p className="lead" style={{ marginTop: 18, maxWidth: 460 }}>
                Your backyard&rsquo;s water, finally making sense. Upload your Flume export and
                <b> Flo</b> tells you — in plain English — what your sprinklers are really up to.
              </p>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 26, justifyContent: "inherit" }}>
                <Link href="/" className="btn sky">Open the app →</Link>
                <a href="#dashboard" className="btn ghost">See the redesign</a>
              </div>
            </div>
            <div className="hero-flo" style={{ display: "flex", justifyContent: "center", position: "relative" }}>
              {/* ripples under Flo */}
              <div style={{ position: "absolute", bottom: 6, width: 150, height: 40 }}>
                {[0, 1].map((i) => (
                  <span key={i} style={{
                    position: "absolute", left: "50%", bottom: 8, width: 120, height: 34,
                    marginLeft: -60, border: "2px solid var(--sky)", borderRadius: "50%",
                    animation: `ripple 3s ease-out ${i * 1.5}s infinite`,
                  }} />
                ))}
              </div>
              <Flo mood="wave" size={190} idle />
            </div>
          </div>
        </div>

        {/* rolling hills */}
        <svg className="hills" viewBox="0 0 1200 120" preserveAspectRatio="none">
          <path d="M0 70 Q300 20 600 60 T1200 50 V120 H0 Z" fill="#8FD48A" />
          <path d="M0 88 Q300 52 600 84 T1200 74 V120 H0 Z" fill="#4FB05A" />
        </svg>
      </header>

      {/* ============================ VOICE ============================ */}
      <section style={{ background: "var(--cream)" }}>
        <div className="wrap">
          <div className="sec-head">
            <span className="eyebrow">The personality</span>
            <h2>Meet Flo, your water buddy</h2>
            <p className="lead">
              Water data is dry (pun intended). Flo is the opposite — a cheerful drop who reads your
              meter like a weather anchor reads the sky. She&rsquo;s the difference between a spreadsheet
              and a friend leaning over the fence to say &ldquo;hey, zone 5 looks thirsty.&rdquo;
            </p>
          </div>

          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))" }}>
            {[
              { i: "☀️", t: "Cheerful", d: "Optimistic by default. A flat, healthy week deserves a little confetti." },
              { i: "🎯", t: "Straight-talking", d: "Numbers in plain English. No jargon walls, no dashboards that need a manual." },
              { i: "🤝", t: "On your side", d: "Never scolds. Points at the problem, then hands you the fix." },
              { i: "🔍", t: "A little nerdy", d: "Loves a baseline and a gallon-per-minute. Geeks out so you don't have to." },
            ].map((c) => (
              <div key={c.t} className="soft" style={{ padding: 20 }}>
                <div style={{ fontSize: 28 }}>{c.i}</div>
                <h3 style={{ fontSize: 20, margin: "10px 0 6px", fontWeight: 600 }}>{c.t}</h3>
                <p style={{ color: "var(--ink-soft)", fontSize: 15, margin: 0 }}>{c.d}</p>
              </div>
            ))}
          </div>

          {/* before / after voice */}
          <div className="card" style={{ marginTop: 30, padding: "clamp(20px,3vw,30px)" }}>
            <span className="eyebrow">Tone of voice · before → after</span>
            <table className="tone" style={{ marginTop: 8 }}>
              <tbody>
                {[
                  { o: "Alert: Station 5 flow 24% above baseline for 2 consecutive days.", n: "Heads up — Zone 5 has been drinking ~24% more than usual for two days. Could be a stuck valve. Want to peek?" },
                  { o: "No anomalies detected in selected range.", n: "All quiet out back. Your yard sipped exactly as planned this week. 🌿" },
                  { o: "Config window created. effectiveFrom=2026-06-01.", n: "Got it — I'll treat June 1 as the day your new schedule kicked in." },
                ].map((r, i) => (
                  <tr key={i}>
                    <td style={{ width: "42%", background: "#F4EEE2", borderRadius: 12, color: "var(--ink-soft)" }}>
                      <span className="num" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "#9a8f78" }}>Old</span>
                      <div style={{ fontSize: 14, marginTop: 4 }}>{r.o}</div>
                    </td>
                    <td style={{ width: "4%" }} />
                    <td style={{ background: "var(--mist)", borderRadius: 12, border: "1.5px solid var(--sky)" }}>
                      <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--sky-deep)", fontWeight: 700 }}>Flo</span>
                      <div style={{ fontSize: 14, marginTop: 4 }}>{r.n}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ============================ COLOR ============================ */}
      <section style={{ background: "var(--cream-2)", borderTop: "2px solid var(--ink)", borderBottom: "2px solid var(--ink)" }}>
        <div className="wrap">
          <div className="sec-head">
            <span className="eyebrow">The palette</span>
            <h2>Sunwater</h2>
            <p className="lead">Sky, grass, and afternoon sun over warm paper. Every hue also carries a job — so color always means something.</p>
          </div>

          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
            <Swatch name="Sky" role="Water & primary" hex="#35A7E4" bg="#35A7E4" fg="#fff" />
            <Swatch name="Deep Sky" role="Links, headings" hex="#1B6FA8" bg="#1B6FA8" fg="#fff" />
            <Swatch name="Grass" role="Thriving / healthy" hex="#4FB05A" bg="#4FB05A" fg="#fff" />
            <Swatch name="Sun" role="Watch / attention" hex="#FFC24B" bg="#FFC24B" />
            <Swatch name="Coral" role="Leak / over-baseline" hex="#FF6B5C" bg="#FF6B5C" fg="#fff" />
            <Swatch name="Ink" role="Text & outlines" hex="#143049" bg="#143049" fg="#fff" />
            <Swatch name="Cream" role="Page / paper" hex="#FFF8EC" bg="#FFF8EC" />
            <Swatch name="Mist" role="Panels / house water" hex="#EAF6FC" bg="#EAF6FC" />
          </div>

          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", marginTop: 26 }}>
            {[
              { s: "Thriving", c: "var(--grass)", d: "Within ~10% of baseline. Green means go-play-outside." },
              { s: "Watching", c: "var(--sun-deep)", d: "Drifting up. Not alarming yet — Flo keeps an eye on it." },
              { s: "Leak", c: "var(--coral)", d: ">20% over baseline for 2+ days. Time to grab a wrench." },
            ].map((x) => (
              <div key={x.s} className="soft" style={{ padding: 18, display: "flex", gap: 14, alignItems: "flex-start" }}>
                <span className="dot" style={{ background: x.c, width: 16, height: 16, marginTop: 4, border: "2px solid var(--ink)" }} />
                <div>
                  <div style={{ fontFamily: "var(--font-fredoka)", fontWeight: 600, fontSize: 17 }}>{x.s}</div>
                  <div style={{ color: "var(--ink-soft)", fontSize: 14 }}>{x.d}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ============================ TYPE & MOTIFS ============================ */}
      <section style={{ background: "var(--cream)" }}>
        <div className="wrap">
          <div className="cols-type">
            <div>
              <span className="eyebrow">Type</span>
              <h2 style={{ fontSize: "clamp(26px,3.4vw,36px)", fontWeight: 600, margin: "8px 0 20px" }}>Rounded to talk, precise to count</h2>
              <div className="soft" style={{ padding: 22 }}>
                <div className="disp" style={{ fontSize: 40, fontWeight: 700, lineHeight: 1 }}>Fredoka</div>
                <div style={{ color: "var(--ink-soft)", fontSize: 13, marginBottom: 18 }}>Display &amp; headings · friendly, rounded, unmistakable</div>
                <div style={{ fontSize: 22, fontWeight: 500 }}>Geist Sans — the body voice</div>
                <div style={{ color: "var(--ink-soft)", fontSize: 13, marginBottom: 18 }}>Reads clean at every size, on any screen.</div>
                <div className="num" style={{ fontSize: 30, fontWeight: 600 }}>2,140 gal · 1.71 gpm</div>
                <div style={{ color: "var(--ink-soft)", fontSize: 13 }}>Geist Mono — every number, tabular &amp; aligned</div>
              </div>
            </div>
            <div>
              <span className="eyebrow">Motifs</span>
              <h2 style={{ fontSize: "clamp(26px,3.4vw,36px)", fontWeight: 600, margin: "8px 0 20px" }}>A little kit of parts</h2>
              <div className="grid" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
                {[
                  { e: "💧", n: "Droplet" },
                  { e: "〰️", n: "Ripple" },
                  { e: "☀️", n: "Sun" },
                  { e: "🌿", n: "Grass" },
                  { e: "⏱️", n: "Timer" },
                  { e: "🚿", n: "Spray" },
                ].map((m) => (
                  <div key={m.n} className="soft" style={{ padding: "18px 8px", textAlign: "center" }}>
                    <div style={{ fontSize: 26 }}>{m.e}</div>
                    <div style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 4 }}>{m.n}</div>
                  </div>
                ))}
              </div>
              <div className="soft" style={{ padding: 16, marginTop: 16, display: "flex", gap: 12, alignItems: "center" }}>
                <Flo mood="watching" size={54} />
                <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>
                  Flo has moods — <b>happy</b>, <b>watching</b>, and <b>alert</b> — so the mascot itself is a status indicator.
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ============================ DASHBOARD ============================ */}
      <section id="dashboard" style={{ background: "var(--cream-2)", borderTop: "2px solid var(--ink)" }}>
        <div className="wrap">
          <div className="sec-head">
            <span className="eyebrow">Reimagined · Dashboard</span>
            <h2>Flo reads you the headline first</h2>
            <p className="lead">The old dashboard opened with cards and charts. The new one opens with a sentence — then lets you dig in.</p>
          </div>

          <div className="card" style={{ padding: "clamp(18px,3vw,28px)", background: "linear-gradient(180deg,#fff, #FFFDF8)" }}>
            {/* Flo headline */}
            <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
              <Flo mood="happy" size={78} idle />
              <div style={{ flex: 1, minWidth: 240 }}>
                <div className="disp" style={{ fontSize: "clamp(20px,2.6vw,27px)", fontWeight: 600, lineHeight: 1.2 }}>
                  Your yard drank <span style={{ color: "var(--sky-deep)" }}>2,140 gal</span> this week —{" "}
                  <span style={{ color: "var(--grass-deep)" }}>8% under</span> last week. Nice work. 🌿
                </div>
                <div style={{ color: "var(--ink-soft)", marginTop: 6, fontSize: 14 }}>
                  One thing worth a look: <b style={{ color: "var(--coral)" }}>Zone 5</b> ran hot on Friday.
                </div>
              </div>
              <span className="status" style={{ background: "#E9F7EA", color: "var(--grass-deep)", border: "1.5px solid var(--grass)" }}>
                <span className="dot" style={{ background: "var(--grass)" }} /> Mostly thriving
              </span>
            </div>

            {/* summary tiles */}
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", marginTop: 22 }}>
              {[
                { l: "Total", v: "2,140", u: "gal", c: "var(--ink)" },
                { l: "Sprinklers", v: "1,512", u: "gal", c: "var(--sky-deep)" },
                { l: "House", v: "628", u: "gal", c: "var(--ink-soft)" },
                { l: "Est. cost", v: "$29.94", u: "this wk", c: "var(--sun-deep)" },
              ].map((t) => (
                <div key={t.l} style={{ border: "1.5px solid var(--line)", borderRadius: 14, padding: 14, background: "#fff" }}>
                  <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--ink-soft)", fontWeight: 700 }}>{t.l}</div>
                  <div className="num" style={{ fontSize: 26, fontWeight: 600, color: t.c }}>{t.v}</div>
                  <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>{t.u}</div>
                </div>
              ))}
            </div>

            {/* consumption chart mock */}
            <div style={{ marginTop: 24, border: "1.5px solid var(--line)", borderRadius: 16, padding: 18, background: "#fff" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
                <b className="disp" style={{ fontSize: 16 }}>This week&rsquo;s consumption</b>
                <div style={{ display: "flex", gap: 6 }}>
                  {["2W", "1M", "3M", "1Y"].map((w, i) => (
                    <span key={w} className="num" style={{
                      fontSize: 12, fontWeight: 600, padding: "4px 10px", borderRadius: 8,
                      border: "1.5px solid var(--ink)", background: i === 0 ? "var(--sun)" : "#fff",
                    }}>{w}</span>
                  ))}
                </div>
              </div>
              <div className="bars">
                {week.map((b, i) => (
                  <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1, height: "100%", justifyContent: "flex-end", gap: 6 }}>
                    {b.kind === "leak" && <span title="over baseline" style={{ fontSize: 13 }}>⚠️</span>}
                    <div className="bar" style={{ height: `${b.v}%`, background: barColor(b.kind), width: "100%" }} />
                    <span className="num" style={{ fontSize: 11, color: "var(--ink-soft)" }}>{b.d}</span>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 16, marginTop: 12, fontSize: 12, color: "var(--ink-soft)", flexWrap: "wrap" }}>
                <span><span className="dot" style={{ background: "var(--sky)" }} /> Sprinklers</span>
                <span><span className="dot" style={{ background: "var(--mist)", border: "1px solid var(--line)" }} /> House</span>
                <span><span className="dot" style={{ background: "var(--coral)" }} /> Over baseline ⚠️</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ============================ CONFIG SIMPLIFIED ============================ */}
      <section style={{ background: "var(--cream)", borderTop: "2px solid var(--ink)" }}>
        <div className="wrap">
          <div className="sec-head">
            <span className="eyebrow">Reimagined · Configuration</span>
            <h2>Setup that reads like a sentence</h2>
            <p className="lead">
              The engine still tracks config windows and programs A/B/C. But you shouldn&rsquo;t have to.
              We hide the machinery behind plain language and only ask for what changed.
            </p>
          </div>

          <div className="cols2" style={{ alignItems: "stretch" }}>
            {/* BEFORE */}
            <div className="soft" style={{ padding: 20, background: "#F4EEE2" }}>
              <span className="chip" style={{ borderColor: "#c9bfa6", background: "#fff" }}>😵 Before</span>
              <div className="num" style={{ marginTop: 14, fontSize: 12.5, color: "#6c6350", lineHeight: 1.7 }}>
                <div>Timer T1 › Program A ▾</div>
                <div>effectiveFrom: 2026-06-01</div>
                <div>days: [Mon,Wed,Fri] start: 04:00</div>
                <div>station T1-05 durationMin: 12 enabled ☑</div>
                <div>baselineGpm: 1.71 · runOrder: 5</div>
                <div style={{ opacity: 0.6 }}>Program B ▸ Program C ▸</div>
                <div>sprinklerOnThreshold · gallonsPerUnit: 748</div>
              </div>
              <p style={{ fontSize: 13, color: "#7a7059", marginTop: 14, marginBottom: 0 }}>
                Powerful, but every knob is on screen at once. New users bounce.
              </p>
            </div>

            {/* AFTER */}
            <div className="card" style={{ padding: 22 }}>
              <span className="chip" style={{ background: "var(--mist)", borderColor: "var(--sky)" }}>✨ After</span>
              <div style={{ marginTop: 14 }}>
                <div className="disp" style={{ fontSize: 18, fontWeight: 600 }}>Front yard timer</div>
                <div style={{ fontSize: 15, color: "var(--ink-soft)", marginTop: 4 }}>
                  Waters <b style={{ color: "var(--ink)" }}>Mon, Wed &amp; Fri</b> starting at{" "}
                  <b style={{ color: "var(--ink)" }}>4:00 am</b>.
                  <a className="plain" href="#" style={{ marginLeft: 6 }}>Edit</a>
                </div>
              </div>

              {/* station rows */}
              <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                {[
                  { n: "Rose bed", m: 8, s: "ok" },
                  { n: "Side lawn", m: 12, s: "ok" },
                  { n: "Back lawn (Zone 5)", m: 12, s: "leak" },
                ].map((st) => (
                  <div key={st.n} style={{ display: "flex", alignItems: "center", gap: 10, border: "1.5px solid var(--line)", borderRadius: 12, padding: "10px 12px" }}>
                    <span className="dot" style={{ width: 12, height: 12, border: "2px solid var(--ink)", background: st.s === "leak" ? "var(--coral)" : "var(--grass)" }} />
                    <span style={{ fontWeight: 600, flex: 1 }}>{st.n}</span>
                    <span className="num" style={{ color: "var(--ink-soft)", fontSize: 14 }}>{st.m} min</span>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 16, background: "var(--mist)", borderRadius: 12, padding: "12px 14px", display: "flex", gap: 10, alignItems: "center" }}>
                <Flo mood="watching" size={40} />
                <div style={{ fontSize: 13.5, color: "var(--ink)" }}>
                  Changed something on the timer? Just tell me the date — I&rsquo;ll keep your history straight.
                  <a className="plain" href="#" style={{ marginLeft: 4 }}>Log a change</a>
                </div>
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 12 }}>
                Advanced schedules (B &amp; C) &amp; billing tucked under <b>“More options”</b> — there when you need them, gone when you don&rsquo;t.
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ============================ SHARE & SCHEDULE ============================ */}
      <section style={{ background: "linear-gradient(180deg,#EAF6FC, var(--cream))", borderTop: "2px solid var(--ink)" }}>
        <div className="wrap">
          <div className="sec-head">
            <span className="eyebrow">New capability · Reports</span>
            <h2>Share the yard, or let Flo email it</h2>
            <p className="lead">
              Turn any week into a clean, shareable <b>Yard Report</b> — send a link to your spouse or your
              landscaper — or have Flo drop a friendly recap in your inbox every Sunday morning.
            </p>
          </div>

          <div className="cols-report">
            {/* left: controls */}
            <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              {/* share link */}
              <div className="card" style={{ padding: 20 }}>
                <div className="disp" style={{ fontSize: 18, fontWeight: 600 }}>🔗 Share a link</div>
                <p style={{ color: "var(--ink-soft)", fontSize: 14, margin: "6px 0 14px" }}>Read-only snapshot. No account needed to view.</p>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <div className="num" style={{ flex: 1, minWidth: 220, border: "1.5px solid var(--line)", borderRadius: 12, padding: "11px 14px", background: "var(--cream)", color: "var(--ink-soft)", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    sprinklerfun.app/r/sunny-otter-42
                  </div>
                  <button className="btn">Copy link</button>
                </div>
              </div>

              {/* scheduled email */}
              <div className="card" style={{ padding: 20 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                  <div className="disp" style={{ fontSize: 18, fontWeight: 600 }}>📬 Flo&rsquo;s weekly check-in</div>
                  {/* toggle */}
                  <span aria-hidden style={{ width: 52, height: 30, borderRadius: 99, background: "var(--grass)", border: "2px solid var(--ink)", position: "relative", flexShrink: 0 }}>
                    <span style={{ position: "absolute", top: 2, right: 2, width: 22, height: 22, borderRadius: 99, background: "#fff", border: "2px solid var(--ink)" }} />
                  </span>
                </div>
                <p style={{ color: "var(--ink-soft)", fontSize: 14, margin: "6px 0 16px" }}>A plain-English recap, only flagging what needs you.</p>

                <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <label style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--ink-soft)" }}>
                    Every
                    <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                      {["Fri", "Sat", "Sun"].map((d, i) => (
                        <span key={d} className="num" style={{ padding: "8px 12px", borderRadius: 10, border: "1.5px solid var(--ink)", background: i === 2 ? "var(--sky)" : "#fff", color: i === 2 ? "#fff" : "var(--ink)", fontWeight: 600 }}>{d}</span>
                      ))}
                    </div>
                  </label>
                  <label style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--ink-soft)" }}>
                    At
                    <div className="num" style={{ marginTop: 8, padding: "9px 12px", borderRadius: 10, border: "1.5px solid var(--ink)", background: "#fff", color: "var(--ink)", fontWeight: 600, display: "inline-block" }}>7:00 am ▾</div>
                  </label>
                </div>

                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--ink-soft)", marginBottom: 8 }}>Send to</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <span className="chip" style={{ background: "var(--mist)" }}>me@home.com ✕</span>
                    <span className="chip" style={{ background: "var(--mist)" }}>landscaper@greenco.com ✕</span>
                    <span className="chip" style={{ borderStyle: "dashed", color: "var(--ink-soft)" }}>+ Add</span>
                  </div>
                </div>
              </div>
            </div>

            {/* right: email preview on a phone */}
            <div style={{ display: "flex", justifyContent: "center" }}>
              <div className="phone">
                <div className="notch" />
                <div className="screen">
                  <div style={{ background: "linear-gradient(180deg,#CFEEFB,#EAF6FC)", padding: "16px 14px 10px", borderBottom: "2px solid var(--ink)" }}>
                    <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>From Flo · Sun 7:00 am</div>
                    <div className="disp" style={{ fontSize: 17, fontWeight: 600, marginTop: 2 }}>Your yard report is in 🌿</div>
                  </div>
                  <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <Flo mood="happy" size={46} />
                      <div style={{ fontSize: 13, color: "var(--ink)" }}>Good news — you used <b>8% less</b> than last week!</div>
                    </div>
                    <div style={{ background: "var(--cream)", border: "1.5px solid var(--line)", borderRadius: 12, padding: 12 }}>
                      <div className="num" style={{ fontSize: 24, fontWeight: 700, color: "var(--sky-deep)" }}>2,140 gal</div>
                      <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>≈ $29.94 · 7 days</div>
                    </div>
                    <div style={{ background: "#FFEFEC", border: "1.5px solid var(--coral)", borderRadius: 12, padding: 12, display: "flex", gap: 8 }}>
                      <span>⚠️</span>
                      <div style={{ fontSize: 12.5 }}><b>Zone 5</b> ran ~24% hot Friday. Might be a stuck valve.</div>
                    </div>
                    <div style={{ textAlign: "center", background: "var(--sun)", border: "2px solid var(--ink)", borderRadius: 12, padding: "10px", fontFamily: "var(--font-fredoka)", fontWeight: 600, fontSize: 14 }}>
                      Open full report →
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ============================ RESPONSIVE ============================ */}
      <section style={{ background: "var(--cream-2)", borderTop: "2px solid var(--ink)" }}>
        <div className="wrap">
          <div className="sec-head">
            <span className="eyebrow">Built for the fence-line</span>
            <h2>Pocket-sized, porch-sized, all the same yard</h2>
            <p className="lead">You check the app standing in the garden with muddy hands, or at the kitchen table. Every layout reflows from one column to three without losing Flo&rsquo;s voice.</p>
          </div>
          <div style={{ display: "flex", gap: 26, flexWrap: "wrap", justifyContent: "center" }}>
            {/* mobile dashboard */}
            <div className="phone">
              <div className="notch" />
              <div className="screen">
                <div style={{ background: "linear-gradient(180deg,#CFEEFB,#fff)", padding: "14px", borderBottom: "2px solid var(--ink)", display: "flex", gap: 10, alignItems: "center" }}>
                  <Flo mood="happy" size={44} />
                  <div className="disp" style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.25 }}>2,140 gal — 8% under last week 🌿</div>
                </div>
                <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ display: "flex", gap: 8 }}>
                    {[["Sprinklers", "1,512"], ["House", "628"]].map(([l, v]) => (
                      <div key={l} style={{ flex: 1, border: "1.5px solid var(--line)", borderRadius: 10, padding: 10 }}>
                        <div style={{ fontSize: 10, textTransform: "uppercase", color: "var(--ink-soft)", fontWeight: 700 }}>{l}</div>
                        <div className="num" style={{ fontSize: 18, fontWeight: 600, color: "var(--sky-deep)" }}>{v}</div>
                      </div>
                    ))}
                  </div>
                  <div className="bars" style={{ height: 90 }}>
                    {week.map((b, i) => (
                      <div key={i} className="bar" style={{ height: `${b.v}%`, background: barColor(b.kind) }} />
                    ))}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#FFEFEC", border: "1.5px solid var(--coral)", borderRadius: 10, padding: "8px 10px", fontSize: 11.5 }}>
                    ⚠️ <span><b>Zone 5</b> ran hot Friday</span>
                  </div>
                </div>
              </div>
            </div>

            {/* mobile config */}
            <div className="phone">
              <div className="notch" />
              <div className="screen">
                <div style={{ padding: "14px", borderBottom: "2px solid var(--ink)", background: "var(--cream)" }}>
                  <div className="disp" style={{ fontSize: 15, fontWeight: 600 }}>Front yard timer</div>
                  <div style={{ fontSize: 11.5, color: "var(--ink-soft)" }}>Mon · Wed · Fri — 4:00 am</div>
                </div>
                <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                  {[["Rose bed", "8 min", "var(--grass)"], ["Side lawn", "12 min", "var(--grass)"], ["Back lawn", "12 min", "var(--coral)"]].map(([n, m, c]) => (
                    <div key={n} style={{ display: "flex", alignItems: "center", gap: 8, border: "1.5px solid var(--line)", borderRadius: 10, padding: "9px 10px" }}>
                      <span className="dot" style={{ width: 10, height: 10, background: c, border: "1.5px solid var(--ink)" }} />
                      <span style={{ fontWeight: 600, flex: 1, fontSize: 13 }}>{n}</span>
                      <span className="num" style={{ fontSize: 12, color: "var(--ink-soft)" }}>{m}</span>
                    </div>
                  ))}
                  <div style={{ textAlign: "center", background: "var(--sun)", border: "2px solid var(--ink)", borderRadius: 10, padding: "9px", fontFamily: "var(--font-fredoka)", fontWeight: 600, fontSize: 13, marginTop: 4 }}>
                    + Log a change
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ============================ FOOTER ============================ */}
      <footer style={{ background: "var(--ink)", color: "#EAF6FC", borderTop: "3px solid var(--ink)" }}>
        <div className="wrap" style={{ padding: "44px 20px", textAlign: "center" }}>
          <Flo mood="happy" size={64} />
          <div className="disp" style={{ fontSize: 26, fontWeight: 700, marginTop: 10 }}>
            Sprinkler<span style={{ color: "#7FD3F5" }}>Fun</span>
          </div>
          <p style={{ color: "#9db6c9", maxWidth: 440, margin: "10px auto 20px", fontSize: 14 }}>
            The Sunwater design system — a personality-first redesign of a smart-meter analyzer.
            Made for one homeowner, one yard, and a whole lot of gallons.
          </p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <Link href="/about" className="btn ghost" style={{ color: "var(--ink)" }}>← Back to About</Link>
            <Link href="/" className="btn">Open the app</Link>
          </div>
          <div style={{ marginTop: 24, fontSize: 12.5, color: "#6f8ba0" }}>Designed with 💧 · a UX exploration</div>
        </div>
      </footer>
    </div>
  )
}
