import { useEffect, useMemo, useState } from 'react'
import { loadStickers } from '../lib/stickers'

/**
 * 表情面板（2026-10-15 改成微信那种形态）。
 *
 * 三段式：
 *   ① 内容区：网格（静止时用**静态首帧** —— 一格一格播几十个雪碧图会白烧 CPU）
 *   ② 底部**分类栏**：`最近使用` + 各表情包（现在只有一个包，以后加包就是多一个 tab）
 *   ③ 「最近使用」存在本机（localStorage），不上传 —— 服务器不知道你常用哪些
 *
 * ⚠️ **不常驻**：只有点开时才挂载、才去取清单（使用者的性能标准：常驻 9.5MB JS 堆被他否掉过）。
 * ⚠️ 面板是**占位式**（把消息区顶上去），不是浮在消息上的浮层；与「+」面板互斥（见 ChatThread）。
 */
const RECENT_KEY = 'moments_sticker_recent_v1'
const RECENT_MAX = 8

function readRecent() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : []
  } catch { return [] }
}

export default function StickerPicker({ onPick, onClose }) {
  const [pack, setPack] = useState(null)
  const [recent, setRecent] = useState(() => readRecent())
  // 默认开「最近使用」；没记录时落到「全部」，免得一进来是空面板
  // 默认开「最近」；没有记录时落到第一个分类（key 由清单决定，见 lib/stickers.js）
  const [tab, setTab] = useState(() => (readRecent().length > 0 ? 'recent' : ''))

  useEffect(() => {
    let cancelled = false
    loadStickers().then((res) => { if (!cancelled) setPack(res) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const byId = useMemo(() => new Map((pack?.packs ?? []).flatMap((p) => p.items).map((it) => [it.id, it])), [pack])
  const packs = pack?.packs ?? []
  const activePack = packs.find((p) => p.key === tab) ?? packs[0]
  const shown = tab === 'recent'
    ? recent.map((id) => byId.get(id)).filter(Boolean)
    : (activePack?.items ?? [])
  // 「最近」是虚拟分类；其余按 packs 里的 key 高亮（tab 为空时视为第一个分类）
  const activeKey = tab === 'recent' ? 'recent' : (activePack?.key ?? '')

  function pick(id) {
    const next = [id, ...readRecent().filter((x) => x !== id)].slice(0, RECENT_MAX)
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)) } catch { /* 存不下就算了 */ }
    setRecent(next)
    onPick?.(id)
  }

  return (
    <div className="sticker-picker" role="dialog" aria-label="表情" data-sticker-panel="1">
      <div className="sticker-picker-body">
        {!pack && <p className="status-text">加载中…</p>}
        {pack && shown.length === 0 && (
          <p className="status-text sticker-empty">
            {tab === 'recent' ? '还没有用过的表情 —— 发几个之后会出现在这里' : '这个包里还没有表情'}
          </p>
        )}
        {pack && shown.length > 0 && (
          <div className="sticker-grid">
            {shown.map((it) => (
              <button
                key={it.id}
                type="button"
                className="sticker-grid-item"
                title={it.label}
                aria-label={it.label}
                onClick={() => pick(it.id)}
              >
                <img src={it.posterSrc} alt="" width={48} height={48} loading="lazy" />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 底部分类栏：和微信一样，用图标 + 小字，当前项高亮 */}
      <div className="sticker-tabs" role="tablist" aria-label="表情分类">
        <button
          type="button"
          role="tab"
          className={`sticker-tab${tab === 'recent' ? ' on' : ''}`}
          aria-selected={tab === 'recent'}
          data-sticker-tab="recent"
          onClick={() => setTab('recent')}
        >
          <span className="sticker-tab-icon" aria-hidden="true">🕘</span>
          <span className="sticker-tab-label">最近</span>
        </button>
        {packs.map((pk) => (
          <button
            key={pk.key}
            type="button"
            role="tab"
            className={`sticker-tab${activeKey === pk.key ? ' on' : ''}`}
            aria-selected={activeKey === pk.key}
            data-sticker-tab={pk.key}
            title={pk.label}
            onClick={() => setTab(pk.key)}
          >
            <span className="sticker-tab-icon" aria-hidden="true">
              {pk.key === 'noto' ? '🛰' : '😊'}
            </span>
            <span className="sticker-tab-label">{pk.label}</span>
          </button>
        ))}
        <button
          type="button"
          className="sticker-tab sticker-tab-close"
          aria-label="收起表情"
          onClick={onClose}
        >
          <span className="sticker-tab-icon" aria-hidden="true">⌄</span>
          <span className="sticker-tab-label">收起</span>
        </button>
      </div>
    </div>
  )
}
