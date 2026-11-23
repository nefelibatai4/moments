import { useId } from 'react'

// 一条鱼的矢量画法：身体 / 尾鳍 / 背鳍 / 花纹都是数据驱动的，
// 20 种鱼共用这一套骨架，靠 shape、tail、pattern 和配色区分。
// 鱼头朝右，原点在身体中心；外层负责位置和朝向。

function BodyShape({ shape, ...rest }) {
  switch (shape) {
    case 'long':
      return <ellipse rx="52" ry="16" {...rest} />
    case 'flat':
      return <ellipse rx="34" ry="40" {...rest} />
    case 'ray':
      return (
        <path d="M 64 0 C 40 -18 18 -30 -2 -30 C -20 -30 -38 -18 -54 -6 L -66 -22 L -58 0 L -66 22 L -54 6 C -38 18 -20 30 -2 30 C 18 30 40 18 64 0 Z" {...rest} />
      )
    case 'seahorse':
      return (
        <path d="M 20 -44 C 34 -38 34 -22 24 -14 C 14 -6 14 6 22 16 C 30 26 24 40 8 42 C -4 44 -14 36 -12 26 C -10 18 -2 16 2 22 C 6 28 0 32 -4 28 C -10 22 -4 12 8 8 C 20 4 22 -8 12 -16 C 2 -24 -4 -34 6 -42 C 10 -45 16 -46 20 -44 Z" {...rest} />
      )
    case 'sun':
      return <circle r="38" {...rest} />
    case 'sail':
      return (
        <path d="M -54 0 C -50 -14 -20 -20 8 -18 C 36 -16 52 -8 58 0 C 52 8 36 16 8 18 C -20 20 -50 14 -54 0 Z" {...rest} />
      )
    case 'ribbon':
      return (
        <path d="M 46 0 C 32 -16 14 -18 -2 -10 C -18 -2 -34 2 -48 -4 C -54 -6 -58 -4 -60 0 C -56 10 -42 14 -26 12 C -10 10 4 6 18 10 C 32 14 44 12 46 0 Z" {...rest} />
      )
    case 'shark':
      return (
        <path d="M -58 0 C -56 -16 -36 -24 -8 -22 C 20 -20 42 -12 62 0 C 42 10 20 18 -8 20 C -36 22 -56 14 -58 0 Z" {...rest} />
      )
    case 'round':
    default:
      return <ellipse rx="38" ry="27" {...rest} />
  }
}

function Tail({ type, fill }) {
  switch (type) {
    case 'fork':
      return (
        <path
          d="M -36 0 L -72 -24 L -62 -2 L -72 24 Z"
          fill={fill}
          stroke="rgba(255,255,255,0.12)"
          strokeWidth="1"
        />
      )
    case 'round':
      return (
        <path
          d="M -32 0 C -52 -24 -66 -16 -64 0 C -66 16 -52 24 -32 0 Z"
          fill={fill}
          stroke="rgba(255,255,255,0.12)"
          strokeWidth="1"
        />
      )
    case 'ribbon':
      return (
        <path
          d="M -34 0 C -54 -12 -62 14 -86 2 C -76 22 -58 22 -46 10 C -40 5 -36 2 -34 0 Z"
          fill={fill}
          opacity="0.9"
        />
      )
    case 'fan':
    default:
      return (
        <path
          d="M -32 0 L -68 -26 L -58 0 L -68 26 Z"
          fill={fill}
          stroke="rgba(255,255,255,0.12)"
          strokeWidth="1"
        />
      )
  }
}

function Dorsal({ shape, fill }) {
  if (shape === 'sail') {
    return (
      <path
        d="M -12 -14 C -4 -54 18 -62 34 -20 L 26 -12 C 12 -26 2 -26 -6 -12 Z"
        fill={fill}
        opacity="0.92"
      />
    )
  }
  if (shape === 'shark') {
    return <path d="M -6 -20 L 12 -52 L 30 -18 Z" fill={fill} opacity="0.92" />
  }
  if (shape === 'flat' || shape === 'fan') {
    return (
      <path
        d="M -24 -24 C -14 -54 10 -54 22 -24 L 10 -18 C 2 -36 -12 -36 -18 -18 Z"
        fill={fill}
        opacity="0.82"
      />
    )
  }
  if (shape === 'round' || shape === 'sun') {
    return (
      <path
        d="M -18 -22 C -10 -42 8 -42 18 -22 L 8 -16 C 2 -30 -8 -30 -14 -16 Z"
        fill={fill}
        opacity="0.78"
      />
    )
  }
  return (
    <path
      d="M -18 -14 C -10 -32 6 -32 16 -14 L 6 -10 C 0 -22 -10 -22 -14 -10 Z"
      fill={fill}
      opacity="0.72"
    />
  )
}

function Pattern({ type, clipId, species }) {
  if (type === 'stripes') {
    return (
      <g clipPath={`url(#${clipId})`} opacity="0.72">
        {[-28, -8, 14, 36].map((x, i) => (
          <path
            key={x}
            d={`M ${x} -50 C ${x + 8} -20 ${x + 2} 18 ${x - 4} 50`}
            stroke={species.accent}
            strokeWidth={i === 0 ? 7 : 6}
            fill="none"
          />
        ))}
      </g>
    )
  }
  if (type === 'spots') {
    const dots = species.rarity === 'endangered'
      ? [[-34, -10], [-18, 8], [-2, -16], [12, 6], [26, -10], [38, 0], [-24, 18], [4, 18], [30, 14], [-44, 4]]
      : [[-22, -8], [-8, 8], [6, -12], [20, 4], [32, -4], [-34, 10], [10, 16]]
    return (
      <g clipPath={`url(#${clipId})`} opacity="0.82">
        {dots.map(([cx, cy], i) => (
          <circle
            key={`${cx}-${cy}`}
            cx={cx}
            cy={cy}
            r={species.rarity === 'endangered' ? 3.4 : 4.4 - (i % 2)}
            fill={species.accent}
          />
        ))}
      </g>
    )
  }
  if (type === 'glow') {
    return (
      <g clipPath={`url(#${clipId})`}>
        <ellipse cx="0" cy="0" rx="34" ry="20" fill={species.accent} opacity="0.18" />
        <circle cx="18" cy="-6" r="5" fill={species.accent} className="fish-lantern-dot" />
        <circle cx="-18" cy="8" r="3.5" fill={species.accent} className="fish-lantern-dot" />
      </g>
    )
  }
  return null
}

export default function FishShape({ species, className = '', muted = false }) {
  const rawId = useId()
  const clipId = `fish-clip-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const { shape, tail, pattern, body, fin, accent, size = 1 } = species

  return (
    <g
      className={`fish-shape${species.glow ? ' fish-shape-glow' : ''}${muted ? ' fish-shape-muted' : ''} ${className}`}
      transform={`scale(${size})`}
      style={{ '--fish-accent': accent }}
    >
      <g className="fish-tail">
        <Tail type={tail} fill={fin} />
      </g>
      <Dorsal shape={shape} fill={fin} />
      <g className="fish-body">
        <BodyShape
          shape={shape}
          fill={body}
          stroke="rgba(255,255,255,0.20)"
          strokeWidth="1.5"
        />
      </g>
      <clipPath id={clipId}>
        <BodyShape shape={shape} />
      </clipPath>
      <Pattern type={pattern} clipId={clipId} species={species} />
      <path
        d={shape === 'shark'
          ? 'M -48 -2 C -20 -8 12 -8 46 -2'
          : 'M -30 -4 C -6 -14 16 -14 32 -4'}
        stroke={accent}
        strokeWidth="3"
        strokeLinecap="round"
        opacity="0.3"
        fill="none"
        clipPath={`url(#${clipId})`}
      />
      <ellipse
        cx={shape === 'seahorse' ? 4 : 12}
        cy={shape === 'seahorse' ? 6 : 12}
        rx={shape === 'seahorse' ? 6 : 10}
        ry={shape === 'seahorse' ? 12 : 6}
        fill={fin}
        opacity="0.8"
        transform={shape === 'seahorse' ? 'rotate(-24 4 6)' : 'rotate(24 12 12)'}
      />
      <circle
        cx={shape === 'seahorse' ? 15 : 28}
        cy={shape === 'seahorse' ? -32 : -6}
        r={shape === 'seahorse' ? 4.6 : 4.2}
        fill="#f8fbff"
      />
      <circle
        cx={shape === 'seahorse' ? 16.4 : 29.4}
        cy={shape === 'seahorse' ? -32 : -6}
        r="2.2"
        fill="#07151c"
      />
      <path
        d={shape === 'seahorse' ? 'M 20 -18 L 24 -22' : 'M 35 4 Q 39 6 42 2'}
        stroke="rgba(7,21,28,0.65)"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
      />
      {species.glow ? <circle cx="42" cy="0" r="3" fill={accent} className="fish-glow-dot" /> : null}
    </g>
  )
}
