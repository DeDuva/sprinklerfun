"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

const links = [
  { href: "/", label: "Dashboard" },
  { href: "/analysis", label: "Analysis" },
  { href: "/config", label: "Config" },
  { href: "/about", label: "About" },
]

export default function Navbar() {
  const pathname = usePathname()

  return (
    <nav className="border-b bg-white sticky top-0 z-40">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-4 sm:gap-6 overflow-x-auto no-scrollbar">
        <span className="font-bold text-blue-600 text-base sm:text-lg mr-1 sm:mr-2 shrink-0 whitespace-nowrap">
          💧 SprinklerFun
        </span>
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className={`text-sm font-medium transition-colors hover:text-blue-600 shrink-0 whitespace-nowrap ${
              pathname === l.href ? "text-blue-600" : "text-gray-600"
            }`}
          >
            {l.label}
          </Link>
        ))}
      </div>
    </nav>
  )
}
