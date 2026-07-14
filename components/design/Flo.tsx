import type { CSSProperties } from "react"

export type FloMood = "happy" | "watching" | "alert" | "wave"

/**
 * Flo — the water-droplet mascot and voice of SprinklerFun.
 * A friendly backyard "water buddy" who reports on your yard like a weather anchor.
 * Rendered as a self-contained inline SVG so it works anywhere with no assets.
 */
export default function Flo({
  mood = "happy",
  size = 96,
  className,
  style,
  idle = false,
}: {
  mood?: FloMood
  size?: number
  className?: string
  style?: CSSProperties
  idle?: boolean
}) {
  const uid = `flo-${mood}-${size}`
  // Semantic body tint per mood
  const body =
    mood === "alert"
      ? { top: "#FFD07A", bot: "#FF8A5B" } // warm — she's concerned
      : { top: "#7FD3F5", bot: "#3AA3E0" } // classic water blue

  return (
    <svg
      viewBox="0 0 120 138"
      width={size}
      height={(size * 138) / 120}
      className={className}
      style={style}
      role="img"
      aria-label={`Flo the water droplet, ${mood}`}
    >
      <defs>
        <linearGradient id={`${uid}-body`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={body.top} />
          <stop offset="1" stopColor={body.bot} />
        </linearGradient>
        <radialGradient id={`${uid}-shine`} cx="0.35" cy="0.3" r="0.5">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.85" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* soft ground shadow */}
      <ellipse cx="60" cy="130" rx="30" ry="6" fill="#123047" opacity="0.12" />

      <g
        style={
          idle
            ? { transformOrigin: "60px 70px", animation: "floBob 3.4s ease-in-out infinite" }
            : undefined
        }
      >
        {/* droplet body */}
        <path
          d="M60 6 C60 6 104 60 104 88 A44 44 0 1 1 16 88 C16 60 60 6 60 6 Z"
          fill={`url(#${uid}-body)`}
          stroke="#123047"
          strokeWidth="3.5"
        />
        {/* glossy highlight */}
        <path
          d="M60 6 C60 6 104 60 104 88 A44 44 0 1 1 16 88 C16 60 60 6 60 6 Z"
          fill={`url(#${uid}-shine)`}
        />

        {/* cheeks */}
        <ellipse cx="36" cy="94" rx="8" ry="5.5" fill="#FF8FA0" opacity="0.55" />
        <ellipse cx="84" cy="94" rx="8" ry="5.5" fill="#FF8FA0" opacity="0.55" />

        {/* eyes */}
        {mood === "watching" ? (
          <>
            {/* one raised, curious */}
            <circle cx="45" cy="82" r="9" fill="#fff" stroke="#123047" strokeWidth="2.5" />
            <circle cx="47" cy="83" r="4.2" fill="#123047" />
            <circle cx="75" cy="82" r="9" fill="#fff" stroke="#123047" strokeWidth="2.5" />
            <circle cx="77" cy="83" r="4.2" fill="#123047" />
            <path d="M36 68 Q45 62 54 67" stroke="#123047" strokeWidth="3" fill="none" strokeLinecap="round" />
          </>
        ) : (
          <>
            <circle cx="45" cy="83" r="9.5" fill="#fff" stroke="#123047" strokeWidth="2.5" />
            <circle cx={mood === "alert" ? 45 : 47} cy={mood === "alert" ? 80 : 85} r="4.4" fill="#123047" />
            <circle cx="75" cy="83" r="9.5" fill="#fff" stroke="#123047" strokeWidth="2.5" />
            <circle cx={mood === "alert" ? 75 : 77} cy={mood === "alert" ? 80 : 85} r="4.4" fill="#123047" />
          </>
        )}

        {/* mouth */}
        {mood === "alert" ? (
          <ellipse cx="60" cy="104" rx="6" ry="7" fill="#123047" />
        ) : mood === "watching" ? (
          <path d="M50 104 Q60 110 70 104" stroke="#123047" strokeWidth="3.2" fill="none" strokeLinecap="round" />
        ) : (
          <path d="M46 101 Q60 116 74 101" stroke="#123047" strokeWidth="3.4" fill="#fff" strokeLinecap="round" />
        )}

        {/* worry sweat drop for alert */}
        {mood === "alert" && (
          <path d="M100 64 c4 6 4 10 0 12 c-4 -2 -4 -6 0 -12 Z" fill="#7FD3F5" stroke="#123047" strokeWidth="1.5" />
        )}

        {/* waving little arm */}
        {mood === "wave" && (
          <g style={{ transformOrigin: "102px 92px", animation: "floWave 1.1s ease-in-out infinite" }}>
            <path d="M100 96 q16 -4 20 -18" stroke="#123047" strokeWidth="6" fill="none" strokeLinecap="round" />
            <circle cx="121" cy="76" r="6.5" fill={body.bot} stroke="#123047" strokeWidth="2.5" />
          </g>
        )}
      </g>
    </svg>
  )
}
