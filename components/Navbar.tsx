"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import Flo from "@/components/design/Flo"

const links = [
  { href: "/", label: "Dashboard" },
  { href: "/analysis", label: "Analysis" },
  { href: "/config", label: "Config" },
  { href: "/about", label: "About" },
]

export default function Navbar() {
  const pathname = usePathname()

  return (
    <nav className="border-b-2 border-[#143049]/10 bg-white/90 backdrop-blur sticky top-0 z-40">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-1 sm:gap-2 overflow-x-auto no-scrollbar">
        <Link href="/" className="flex items-center gap-1.5 shrink-0 mr-2 sm:mr-4">
          <Flo size={26} mood="happy" />
          <span
            className="font-semibold text-[#143049] text-base sm:text-lg whitespace-nowrap"
            style={{ fontFamily: "var(--font-fredoka)" }}
          >
            Sprinkler<span className="text-[#1B6FA8]">Fun</span>
          </span>
        </Link>
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className={`text-sm font-medium transition-colors shrink-0 whitespace-nowrap px-3 py-1.5 rounded-full ${
              pathname === l.href
                ? "bg-[#EAF6FC] text-[#1B6FA8]"
                : "text-[#4A6076] hover:text-[#1B6FA8] hover:bg-[#EAF6FC]/60"
            }`}
          >
            {l.label}
          </Link>
        ))}
      </div>
    </nav>
  )
}
