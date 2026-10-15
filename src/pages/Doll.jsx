import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { createAvatar } from '@dicebear/core'
import * as AvataaarsStyle from '@dicebear/avataaars'
import { supabase } from '../supabaseClient'
import { useAuth } from '../lib/AuthContext'
import { safeStorageKey } from '../lib/sanitizeFilename'
import { invalidateSignedUrl, objectLocator } from '../lib/signedUrls'

/**
 * 捏一个"小玩偶形象"（使用者 2026-10-14）。
 *
 * ── 用的是什么 ─────────────────────────────────────────────────
 * 美术是 **Pablo Stanley 的 Avataaars**（作者声明"个人与商用免费"，见 avataaars.com），
 * 通过 **DiceBear** 的 `@dicebear/avataaars` + `@dicebear/core`（MIT、零依赖）渲染成 SVG 字符串。
 *
 * ⚠️ 为什么不直接用 `avataaars` 这个 React 包（一开始就是那么做的，踩了两个坑）：
 *   ① 它是 CJS，默认导入在 Vite 下拿到的是模块对象而不是组件（"Element type is invalid"）；
 *   ② 更致命：它整包依赖 **React 17 的内部 API**（`addStateChangeListener`）→ React 19 下
 *      **一 import 就崩**（连深导入 `dist/avatar` 也一样，因为部件被 `withOptions` 包过）。
 *   换成 DiceBear 之后：框架无关、零依赖、选项直接从它自己的 schema 生成，还更小。
 *
 * ── 两个刻意的取舍 ─────────────────────────────────────────────
 *  ① 这个页面**独立路由**（App 里按需加载）→ 玩偶库只进这个 chunk，
 *     时间线/私聊/插件完全不加载它（那些地方只渲染光栅化后的头像 `<img>`）。
 *  ② 保存时把 SVG **光栅化成 512×512 PNG** 当头像上传（走现有头像链路），
 *     同时把配置存进 `profiles.doll` —— 以后再进来还能接着改。
 *
 * ── 与加密的关系 ───────────────────────────────────────────────
 *  头像与这份配置都是**明文**（见 SECURITY.md 的"头像例外"）：它们是"身份/外观"，不是聊天内容。
 */
const STYLE = AvataaarsStyle.avataaars ?? AvataaarsStyle.default ?? AvataaarsStyle

/** 中文标签（按 schema 的分组名映射；没映射到的就用原名兜底） */
const GROUP_LABELS = {
  top: '发型',
  hairColor: '发色',
  eyebrows: '眉型',
  eyes: '眼睛',
  mouth: '嘴',
  facialHair: '胡子',
  facialHairColor: '胡子颜色',
  accessories: '配饰',
  accessoriesColor: '配饰颜色',
  clothing: '穿搭',
  clothesColor: '衣服颜色',
  clothingGraphic: '衣服图案',
  skinColor: '肤色',
  hatColor: '帽子颜色',
  style: '外形',
  // 这些不展示：概率项、基础设定、鼻子（只有一种）、背景（我们自己给一组）
  nose: null, base: null, backgroundColor: null,
  accessoriesProbability: null, facialHairProbability: null, topProbability: null,
}
const PROBABILITY_KEYS = new Set(['accessoriesProbability', 'facialHairProbability', 'topProbability'])
/** 背景色：DiceBear 默认只给一个，我们自己挑一组柔和的（它接受任意 hex） */
const BACKGROUNDS = ['b6e3f4', 'c0aede', 'd1d4f9', 'ffd5dc', 'ffdfbf', 'e8f0fe', 'fde7e9', 'e6f4ea', 'fff4e5', 'e9eef5']

/** 从 schema 生成"可选项分组"：类型项取 enum，颜色项取 default（都是一串 hex） */
function buildGroups() {
  const props = STYLE.schema?.properties ?? {}
  const groups = []
  for (const [key, spec] of Object.entries(props)) {
    if (PROBABILITY_KEYS.has(key)) continue
    if (GROUP_LABELS[key] === null) continue
    const values = spec?.items?.enum ?? spec?.default ?? []
    if (!Array.isArray(values) || values.length < 2) continue
    const isColor = /^[a-fA-F0-9]{6}$/.test(String(values[0]))
    groups.push({ key, label: GROUP_LABELS[key] ?? key, values, isColor })
  }
  groups.push({ key: 'backgroundColor', label: '背景', values: BACKGROUNDS, isColor: true })
  return groups
}
const GROUPS = buildGroups()

const colorHex = (v) => `#${v}`

/** 把"每组选中一个值"变成 DiceBear 要的选项对象（每项是数组） */
function toOptions(picks) {
  const out = {}
  for (const [k, v] of Object.entries(picks)) if (v) out[k] = [v]
  return out
}

function renderSvg(seed, picks) {
  try {
    return createAvatar(STYLE, { seed: seed || 'moments', ...toOptions(picks) }).toString()
  } catch {
    return ''
  }
}

export default function Doll() {
  const session = useAuth()
  const navigate = useNavigate()
  const [seed, setSeed] = useState(() => Math.random().toString(36).slice(2, 8))
  const [picks, setPicks] = useState({})
  const [tab, setTab] = useState(GROUPS[0]?.key ?? 'top')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [message, setMessage] = useState(null)
  const previewRef = useRef(null)
  const uid = session?.user?.id

  // 进来先把存过的配置读回来
  useEffect(() => {
    if (!uid) return
    supabase.from('profiles').select('doll').eq('id', uid).maybeSingle()
      .then(({ data }) => {
        const saved = data?.doll
        if (saved && typeof saved === 'object') {
          if (saved.seed) setSeed(saved.seed)
          if (saved.picks && typeof saved.picks === 'object') setPicks(saved.picks)
        }
      })
  }, [uid])

  const group = useMemo(() => GROUPS.find((g) => g.key === tab) ?? GROUPS[0], [tab])
  const previewSvg = useMemo(() => renderSvg(seed, picks), [seed, picks])

  /** 把预览的 SVG 光栅化成 512×512 PNG（Safari 要求 SVG 自己带宽高） */
  async function rasterize(svgText) {
    if (!svgText) throw new Error('预览还没准备好')
    const withSize = svgText.replace('<svg ', '<svg width="512" height="512" ')
    const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withSize)}`
    const img = new Image()
    await new Promise((resolve, reject) => {
      img.onload = resolve
      img.onerror = () => reject(new Error('图片生成失败'))
      img.src = src
    })
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 512
    canvas.getContext('2d').drawImage(img, 0, 0, 512, 512)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('图片生成失败')
    return blob
  }

  async function handleSave() {
    if (!uid || saving) return
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      const blob = await rasterize(previewSvg)
      const file = new File([blob], `doll-${Date.now()}.png`, { type: 'image/png' })
      const path = safeStorageKey(uid, file.name)
      const { error: upErr } = await supabase.storage
        .from('avatars')
        .upload(path, file, { contentType: 'image/png' })
      if (upErr) throw upErr
      // ⚠️ **不碰 avatar_url**（使用者 2026-10-14 明确要求："玩偶是玩偶，头像是头像"）。
      //    第一版把玩偶光栅化后直接当成头像写进 avatar_url，于是"捏个玩偶"会把用户自己
      //    上传的照片换掉 —— 那不是我该替他做的决定，也让他找不回原来的头像（虽然对象还在桶里）。
      //    现在玩偶只写进 `doll`（含它自己的图片地址），在【我】/TA 的主页上单独展示。
      const { data: before } = await supabase.from('profiles').select('doll').eq('id', uid).maybeSingle()
      const { data: updated, error: dbErr } = await supabase
        .from('profiles')
        .update({ doll: { seed, picks, image: objectLocator('avatars', path) } })
        .eq('id', uid)
        .select('id')
      if (dbErr) throw dbErr
      if (!updated || updated.length === 0) throw new Error('保存没有生效（可能没有权限）')
      // 旧的那张玩偶图不再被引用：让签名地址缓存失效就行。
      // ⚠️ 刻意**不删**桶里的旧对象：文件名由 safeStorageKey 统一生成（`<uid>/<时间戳>-<uuid>.png`），
      //    没法可靠地区分"这是玩偶图还是他上传的头像" —— 为了几 KB 去赌一次误删不值得。
      const oldImage = before?.doll?.image
      if (oldImage) invalidateSignedUrl('avatars', oldImage)
      setMessage('已保存：玩偶形象已更新（头像不受影响）。')
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="doll-page">
      <div className="doll-head">
        <Link to="/profile" className="doll-back">← 返回</Link>
        <h2>捏个玩偶形象</h2>
      </div>

      <div className="doll-preview" ref={previewRef}>
        <span className="doll-preview-inner" dangerouslySetInnerHTML={{ __html: previewSvg }} />
      </div>

      <div className="doll-actions">
        <button
          type="button"
          className="ghost"
          onClick={() => {
            const next = {}
            for (const g of GROUPS) next[g.key] = g.values[Math.floor(Math.random() * g.values.length)]
            setPicks(next)
            setSeed(Math.random().toString(36).slice(2, 8))
          }}
        >
          🎲 随机一个
        </button>
        <button type="button" className="primary" onClick={handleSave} disabled={saving}>
          {saving ? '保存中…' : '用这个形象'}
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {message && <p className="success-text">{message}</p>}

      <div className="doll-tabs" role="tablist">
        {GROUPS.map((g) => (
          <button
            key={g.key}
            type="button"
            role="tab"
            aria-selected={tab === g.key}
            className={`doll-tab${tab === g.key ? ' on' : ''}`}
            onClick={() => setTab(g.key)}
          >
            {g.label}
          </button>
        ))}
      </div>

      {/* 一次只渲染一个分组：十几个分组一起渲染就是上百个 SVG，没必要 */}
      <div className="doll-options" role="tabpanel" aria-label={group.label}>
        {group.values.map((value) => (
          <button
            key={value}
            type="button"
            className={`doll-option${picks[group.key] === value ? ' on' : ''}`}
            aria-pressed={picks[group.key] === value}
            title={group.isColor ? colorHex(value) : value}
            data-value={value}
            onClick={() => setPicks((prev) => ({ ...prev, [group.key]: value }))}
          >
            {group.isColor ? (
              <span className="doll-swatch" style={{ background: colorHex(value) }} />
            ) : (
              <span
                className="doll-thumb"
                dangerouslySetInnerHTML={{ __html: renderSvg(seed, { ...picks, [group.key]: value }) }}
              />
            )}
          </button>
        ))}
      </div>

      <p className="status-text doll-note">
        形象只是"你的样子"（任何人都看得到，不参与聊天加密）。想换回照片头像，去【我】里重新上传即可。
        <br />
        美术：Pablo Stanley 的 <a href="https://avataaars.com/" target="_blank" rel="noopener noreferrer">Avataaars</a>
        （作者声明个人与商用免费）。
      </p>
      <button type="button" className="ghost" onClick={() => navigate('/profile')}>回到【我】</button>
    </div>
  )
}
