"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import Flo from "@/components/design/Flo"
import { logout } from "@/lib/backend"

const links = [
  { href: "/", label: "Dashboard" },
  { href: "/analysis", label: "Analysis" },
  { href: "/config", label: "Config" },
  { href: "/about", label: "About" },
]

export default function Navbar({ showLogout = false }: { showLogout?: boolean }) {
  const pathname = usePathname()

  // On the login page the nav links point at places the visitor cannot go yet,
  // so the bar is reduced to the mark.
  const onLoginPage = pathname === "/login"

  async function handleLogout() {
    await logout()
    // A full document load, not a client-side navigation: it drops the in-memory
    // store along with the session, so the next person to open the tab does not
    // see the previous one's data still on screen. Absolute URL because assign()
    // with a relative one is ambiguous under a basePath (and ESLint says so).
    window.location.assign(new URL("/login", window.location.origin).toString())
  }

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

        {!onLoginPage &&
          links.map((l) => (
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

        {!onLoginPage && showLogout && (
          <button
            onClick={handleLogout}
            className="ml-auto text-sm font-medium shrink-0 whitespace-nowrap px-3 py-1.5 rounded-full text-[#4A6076] hover:text-[#1B6FA8] hover:bg-[#EAF6FC]/60 transition-colors"
          >
            Log out
          </button>
        )}
      </div>
    </nav>
  )
}
