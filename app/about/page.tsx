import type { Metadata } from "next"
import Link from "next/link"
import Flo from "@/components/design/Flo"

export const metadata: Metadata = {
  title: "About — SprinklerFun",
  description: "What SprinklerFun is, where its data comes from, and the design system behind it.",
}

export default function AboutPage() {
  return (
    <div className="max-w-3xl mx-auto">
      {/* intro */}
      <div className="flex items-center gap-4 mb-6">
        <Flo mood="wave" size={72} idle />
        <div>
          <h1 className="text-3xl font-bold tracking-tight">About SprinklerFun</h1>
          <p className="text-gray-600">Understand and optimize your backyard&rsquo;s water, with fresh meter data every day.</p>
        </div>
      </div>

      <div className="space-y-4 text-[15px] leading-relaxed text-gray-700">
        <p>
          SprinklerFun turns your{" "}
          <a className="text-blue-600 underline" href="https://flumewater.com" target="_blank" rel="noreferrer">Flume smart meter</a>&rsquo;s
          minute-by-minute readings into a clear picture of what your sprinkler system is actually doing —
          spotting the zone that&rsquo;s running hot, the week that spiked, and the schedule change that
          explains it.
        </p>
        <p>
          <b>The data comes in on its own.</b> Once a day the app pulls the latest readings straight from
          Flume, so the dashboard is already current when you open it. Want to see this morning&rsquo;s
          watering right now? <b>Config → Flume sync → Sync now</b> asks immediately. A CSV export from
          Flume still works too, for filling in older history. Readings are matched on their timestamp, so
          nothing is ever counted twice.
        </p>
        <p>
          It&rsquo;s a household app: you sign in with Google, and only the accounts on the household&rsquo;s
          list get in. Everyone who does sees the same data and the same config, on any device.
        </p>
        <p>
          Meet <b>Flo</b>, the water droplet who fronts the experience. She reads your meter like a weather
          anchor reads the sky and tells you, in plain English, what needs a look and what to leave alone.
        </p>
      </div>

      {/* design system callout */}
      <div className="mt-8 rounded-2xl border-2 border-[#143049] bg-gradient-to-b from-[#EAF6FC] to-white p-6 shadow-[6px_6px_0_rgba(20,48,73,0.08)]">
        <div className="flex items-start gap-4">
          <Flo mood="happy" size={64} />
          <div className="flex-1">
            <div className="text-xs font-bold uppercase tracking-widest text-[#1B6FA8]">Design</div>
            <h2 className="text-xl font-semibold text-[#143049] mt-1">The Sunwater design system</h2>
            <p className="text-[#4a6076] text-sm mt-1">
              The full personality, palette, typography, and the reimagined dashboard, simplified config, and
              shareable yard reports live on a standalone page.
            </p>
            <Link
              href="/design"
              className="inline-flex items-center gap-2 mt-4 rounded-xl border-2 border-[#143049] bg-[#FFC24B] px-5 py-2.5 font-semibold text-[#143049] shadow-[3px_3px_0_#143049] hover:translate-y-0.5 transition-transform"
            >
              Explore the design system →
            </Link>
          </div>
        </div>
      </div>

      {/* quick facts */}
      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        {[
          { t: "Dashboard", d: "Flo's monthly headline, station alerts, the last two weeks of consumption, and per-station flow for any day." },
          { t: "Analysis", d: "Timing & flow calibration — reconcile your config to what the meter really saw, including the delay between stations." },
          { t: "Config", d: "A timeline of schedule changes, so each day is analyzed against the settings that were really in effect." },
        ].map((f) => (
          <div key={f.t} className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="font-semibold text-[#143049]">{f.t}</div>
            <div className="text-sm text-gray-600 mt-1">{f.d}</div>
          </div>
        ))}
      </div>

      <p className="mt-8 text-sm text-gray-500">
        Everything runs against your own data. Config is time-aware, so history stays honest even as your
        schedule changes across the seasons.
      </p>
    </div>
  )
}
