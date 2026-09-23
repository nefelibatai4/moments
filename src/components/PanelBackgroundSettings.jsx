import { useState } from 'react'
import {
  getPanelBg,
  setPanelBg,
  panelBgStyle,
  PANEL_BG_DEFAULTS,
} from '../lib/panelBackground'
import { getTheme } from '../lib/theme'

/**
 * 【我】里的「面板背景」设置（使用者 2026-09-22 要求开关放这里）。
 *
 * 控制的是**浏览器插件面板**的背景：扩展点图标浮出来的那一层
 * （真·毛玻璃，能看见并模糊背后的网页；见 extension/overlay.js）。
 *
 * ⚠️ `panelBgStyle()` 里的配色映射**扩展侧有一份副本**
 *    （extension/overlay.js 的 panelBgStyle），因为扩展没有打包器、不能 import 网页代码。
 *    两边必须一致 —— `scripts/verify-extension-panel.cjs` 里有一条断言专门比对
 *    网页预览与浮层实际渲染出来的 backdrop-filter，防止它们悄悄漂移。
 */
export default function PanelBackgroundSettings() {
  const [settings, setSettings] = useState(getPanelBg)
  const update = (patch) => setSettings(setPanelBg(patch))

  // 预览块直接用同一份映射算出样式。它会真的模糊【我】这一页 ——
  // 这是货真价实的预览（同一个 CSS 属性、同一个底色），不是画出来的假图。
  const preview = panelBgStyle(settings, getTheme())

  const choice = (active) => `panel-bg-choice${active ? ' active' : ''}`

  return (
    <div className="panel-bg-section">
      <h3>面板背景</h3>
      <p className="panel-bg-hint">
        控制电脑上插件面板（点扩展图标浮出来的那一层）的背景。
        「毛玻璃」会让你正在看的网页透过面板、并以模糊的方式可见；「纯色」则是一块不透明的底色。
      </p>

      <div className="panel-bg-row">
        <span className="panel-bg-label">背景模式</span>
        <div className="panel-bg-choices" role="group" aria-label="背景模式">
          <button
            type="button"
            className={choice(settings.mode === 'glass')}
            aria-pressed={settings.mode === 'glass'}
            onClick={() => update({ mode: 'glass' })}
          >
            毛玻璃
          </button>
          <button
            type="button"
            className={choice(settings.mode === 'solid')}
            aria-pressed={settings.mode === 'solid'}
            onClick={() => update({ mode: 'solid' })}
          >
            纯色
          </button>
        </div>
      </div>

      <div className="panel-bg-row">
        <span className="panel-bg-label">底色</span>
        <div className="panel-bg-choices" role="group" aria-label="底色">
          <button
            type="button"
            className={choice(settings.tint === 'theme')}
            aria-pressed={settings.tint === 'theme'}
            onClick={() => update({ tint: 'theme' })}
          >
            跟随主题
          </button>
          <button
            type="button"
            className={choice(settings.tint === 'dark')}
            aria-pressed={settings.tint === 'dark'}
            onClick={() => update({ tint: 'dark' })}
          >
            深色
          </button>
          <button
            type="button"
            className={choice(settings.tint === 'light')}
            aria-pressed={settings.tint === 'light'}
            onClick={() => update({ tint: 'light' })}
          >
            浅色
          </button>
        </div>
      </div>

      <div className="panel-bg-row">
        <span className="panel-bg-label">模糊程度</span>
        <div className="panel-bg-slider">
          <input
            type="range"
            min={0}
            max={30}
            step={1}
            value={settings.blur}
            disabled={settings.mode !== 'glass'}
            aria-label="模糊程度"
            onChange={(e) => update({ blur: Number(e.target.value) })}
          />
          <span className="panel-bg-value">{settings.blur}px</span>
        </div>
      </div>
      {settings.mode !== 'glass' && (
        <p className="panel-bg-note">纯色模式下模糊不起作用（没有透出来的东西可模糊）。</p>
      )}

      <div className="panel-bg-preview" style={preview}>
        <span>预览</span>
      </div>

      <button
        type="button"
        className="panel-bg-reset"
        onClick={() => update(PANEL_BG_DEFAULTS)}
      >
        恢复默认
      </button>
    </div>
  )
}
