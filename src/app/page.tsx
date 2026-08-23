"use client"

import { useAuth } from "@/hooks/use-auth"
import { AppShell } from "@/components/app-shell"
import { Loader2 } from "lucide-react"
import { useEffect, useState } from "react"

type BootStage = "checking" | "playing" | "done"

function SynnicalBoot() {
  return (
    <div
      className="synnical-boot"
      role="status"
      aria-label="Starting Synnical"
      style={{
        backgroundImage: "linear-gradient(rgba(0,0,0,.14), rgba(0,0,0,.18)), url(/brand/wallpapers/sakura-samurai-2.png)",
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      <div className="synnical-boot-aura" aria-hidden="true" />
      <div className="synnical-boot-mark" aria-hidden="true">
        <span className="synnical-boot-orbit synnical-boot-orbit-one" />
        <span className="synnical-boot-orbit synnical-boot-orbit-two" />
        <img src="/logo.svg" alt="" />
      </div>
      <div className="synnical-boot-wordmark" aria-hidden="true">SYNNICAL</div>
      <div className="synnical-boot-track" aria-hidden="true"><span /></div>
    </div>
  )
}

export default function Home() {
  const { loading } = useAuth()
  const [bootStage, setBootStage] = useState<BootStage>("checking")

  useEffect(() => {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined
    // A document-level `navigate` is a genuine entry into Synnical. Reloads,
    // history restores and client-side panel changes must never replay boot.
    if (navigation?.type !== "navigate") {
      setBootStage("done")
      return
    }
    setBootStage("playing")
    const timer = window.setTimeout(() => setBootStage("done"), 1500)
    return () => window.clearTimeout(timer)
  }, [])

  if (bootStage === "checking") return <div className="min-h-screen" aria-hidden="true" style={{ backgroundImage: "linear-gradient(rgba(0,0,0,.12), rgba(0,0,0,.18)), url(/brand/wallpapers/sakura-samurai-2.png)", backgroundSize: "cover", backgroundPosition: "center" }} />
  if (bootStage === "playing") return <SynnicalBoot />

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3" style={{ backgroundImage: "linear-gradient(rgba(0,0,0,.14), rgba(0,0,0,.18)), url(/brand/wallpapers/sakura-samurai-2.png)", backgroundSize: "cover", backgroundPosition: "center" }}>
        <Loader2 className="h-7 w-7 animate-spin text-[var(--synnical-accent)]" />
        <p className="text-sm text-[#888888]">Loading Synnical…</p>
      </div>
    )
  }

  // Synnical OS is the direct landing experience. Authentication, mandatory
  // security setup, and account-only apps are handled inside the shared shell.
  return <AppShell />
}
