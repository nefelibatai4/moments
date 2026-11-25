import { useState } from 'react'
import { Link } from 'react-router-dom'
import NavIcon from '../components/NavIcon'
import SplashScreen from '../components/SplashScreen'
import FishingGame from './FishingGame'
import TurtleSoup from './TurtleSoup'
import './lab.css'

// ── 实验室入口（2026-11-19）──────────────────────────────────────────
// 导航栏的【实验室】落到这里。这个目录也是实验室模式的审计边界：
// Ace 可以自主改 `src/lab/`，实验室外的改动仍然要 i4 确认。
//
// 加实验的方式见同目录 README；入口卡片认这几种动作：
//   · to    → 站内路由（react-router 的 Link）
//   · href  → 整页跳转（现有工具靠 URL 参数触发，必须真正刷新一次）
//   · onClick: 'splash'   → 本页直接盖一层预览，不改 URL、不消耗正式时段
//   · onClick: 'fishing'  → 本页进入「摸鱼」小游戏（不新增路由）
//   · onClick: 'turtle'   → 本页进入「海龟汤」多人游戏（不新增路由）
const BASE = import.meta.env.BASE_URL

const EXPERIMENTS = [
  // 视口自检面板只在开发态打包（App.jsx 的动态 import 由 import.meta.env.DEV
  // 守卫）。生产里这张卡不能留，否则会指向一个已被裁掉的面板。
  ...(import.meta.env.DEV
    ? [{
        id: 'viewport',
        title: '视口自检',
        meta: '调试',
        desc: '把刘海、键盘、地址栏的真实尺寸摊开来看。手机上遇到「底栏浮空」「输入框飞走」时，先开它。',
        action: '打开自检',
        href: `${BASE}?debug=1`,
      }]
    : []),
  {
    id: 'fishing',
    title: '摸鱼',
    meta: '新玩具',
    desc: '深海下网，拼出六级单词，把 20 种鱼收进鱼库；鱼分五档稀有度，能解锁六枚成就，在线渔友还能互相看鱼库。',
    action: '下海摸鱼',
    onClick: 'fishing',
  },
  {
    id: 'turtle',
    title: '海龟汤',
    meta: '多人游戏',
    desc: '十份原创悬案档案。一人主持、其他人提问：是、否、无关、部分；猜中汤底或揭底就结案，还能换题继续。',
    action: '进审讯室',
    onClick: 'turtle',
  },
  {
    id: 'splash',
    title: '开屏动画',
    meta: '观感',
    desc: '「欢迎姜女士回家」的完整动效。这里预览不消耗正式时段，随时可以点掉。',
    action: '预览一遍',
    onClick: 'splash',
  },
  {
    id: 'garden',
    title: '私密圈后花园',
    meta: '已在用',
    desc: '两个人的私密圈 + Ace，三人群聊。消息只对参与者可见，服务端看不到内容。',
    action: '去后花园',
    to: '/garden',
  },
]

function LabCard({ index, experiment, onSplash, onGame }) {
  const content = (
    <>
      <span className="lab-card-top">
        <span className="lab-card-index">{String(index + 1).padStart(2, '0')}</span>
        <span className="lab-card-meta">{experiment.meta}</span>
      </span>
      <span className="lab-card-title">{experiment.title}</span>
      <span className="lab-card-desc">{experiment.desc}</span>
      <span className="lab-card-action">
        {experiment.action}
        <span aria-hidden="true"> →</span>
      </span>
    </>
  )

  if (experiment.to) {
    return (
      <Link className="lab-card" to={experiment.to} data-lab-card={experiment.id}>
        {content}
      </Link>
    )
  }
  if (experiment.href) {
    return (
      <a className="lab-card" href={experiment.href} data-lab-card={experiment.id}>
        {content}
      </a>
    )
  }
  if (experiment.onClick === 'splash') {
    return (
      <button
        type="button"
        className="lab-card no-opacity-hover"
        onClick={onSplash}
        data-lab-card={experiment.id}
      >
        {content}
      </button>
    )
  }
  if (experiment.onClick === 'fishing' || experiment.onClick === 'turtle') {
    return (
      <button
        type="button"
        className="lab-card no-opacity-hover"
        onClick={() => onGame(experiment.onClick)}
        data-lab-card={experiment.id}
      >
        {content}
      </button>
    )
  }
  return null
}

export default function LabPage() {
  const [splashPreview, setSplashPreview] = useState(false)
  const [activeGame, setActiveGame] = useState(null)

  if (activeGame === 'fishing') {
    return <FishingGame onExit={() => setActiveGame(null)} />
  }

  if (activeGame === 'turtle') {
    return <TurtleSoup onExit={() => setActiveGame(null)} />
  }

  return (
    <div className="lab-page" data-lab-page>
      <header className="lab-hero">
        <span className="lab-hero-mark" aria-hidden="true">
          <NavIcon name="lab" />
        </span>
        <div className="lab-hero-copy">
          <p className="lab-eyebrow">MOMENTS · LAB</p>
          <h2>实验室</h2>
          <p>正式页面之外的试验田。Ace 在 <code>src/lab/</code> 里做的小东西，会先在这里见人。</p>
        </div>
        <span className="lab-badge">BETA</span>
      </header>

      <section className="lab-section" aria-labelledby="lab-experiments-title">
        <div className="lab-section-head">
          <h3 id="lab-experiments-title">现在能玩的</h3>
          <span className="lab-count">{EXPERIMENTS.length} 个入口</span>
        </div>
        <div className="lab-list">
          {EXPERIMENTS.map((experiment, index) => (
            <LabCard
              key={experiment.id}
              index={index}
              experiment={experiment}
              onSplash={() => setSplashPreview(true)}
              onGame={setActiveGame}
            />
          ))}
        </div>
      </section>

      <section className="lab-rules" aria-labelledby="lab-rules-title">
        <h3 id="lab-rules-title">实验室规矩</h3>
        <ul>
          <li>
            <strong>门内自由</strong>：<code>src/lab/</code> 里的小实验，Ace 可以先做出来再给你看。
          </li>
          <li>
            <strong>门外确认</strong>：搬出实验室、动正式页面，要 i4 点头；跑完还会审计，越界的会被自动回滚。
          </li>
          <li>
            <strong>不碰真东西</strong>：这一页不读动态、私聊和钥匙，也不写任何用户数据。
          </li>
        </ul>
      </section>

      <p className="lab-foot">
        入口只对登录后的成员显示。想加实验，去群里叫 Ace；它会在 <code>src/lab/</code> 里开工。
      </p>

      {splashPreview && <SplashScreen preview onDone={() => setSplashPreview(false)} />}
    </div>
  )
}
