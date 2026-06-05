"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import UploadModal from "./UploadModal"

const links = [
  { href: "/", label: "Dashboard" },
  { href: "/analysis", label: "Analysis" },
  { href: "/config", label: "Config" },
]

export default function Navbar() {
  const pathname = usePathname()
  const [uploadOpen, setUploadOpen] = useState(false)

  return (
    <>
      <nav className="border-b bg-white sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-6">
          <span className="font-bold text-blue-600 text-lg mr-2">💧 SprinklerFun</span>
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`text-sm font-medium transition-colors hover:text-blue-600 ${
                pathname === l.href ? "text-blue-600" : "text-gray-600"
              }`}
            >
              {l.label}
            </Link>
          ))}
          <div className="ml-auto">
            <Button size="sm" onClick={() => setUploadOpen(true)}>
              Upload CSV
            </Button>
          </div>
        </div>
      </nav>
      <UploadModal open={uploadOpen} onClose={() => setUploadOpen(false)} />
    </>
  )
}
