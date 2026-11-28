import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

/**
 * Keyboard and screen-reader behavior of public/widget.js, against a stub DOM
 * (as in widget-open-announce.test.ts): a closed panel cannot be reached with
 * Tab or by assistive tech, the bubble says whether the chat is open, Esc on the
 * page or inside the chat closes it and returns focus to the bubble, only the
 * chat's own frame and origin can ask to close it, and reduced motion turns the
 * panel animation off.
 */

const SOURCE = fs.readFileSync(path.join(process.cwd(), 'public/widget.js'), 'utf8')
const TOKEN = 'a1'.repeat(24)

interface El {
  tag: string
  id: string
  innerHTML: string
  textContent: string
  title: string
  attrs: Record<string, string>
  children: El[]
  listeners: Record<string, (e?: unknown) => void>
  classes: Set<string>
  src: string
  focusCount: number
  contentWindow: object
  focus(): void
  setAttribute(k: string, v: string): void
  getAttribute(k: string): string | null
  removeAttribute(k: string): void
  addEventListener(type: string, fn: (e?: unknown) => void): void
  appendChild(c: El): void
  classList: { add(c: string): void; remove(c: string): void }
}

function el(tag: string): El {
  const e: El = {
    tag,
    id: '',
    innerHTML: '',
    textContent: '',
    title: '',
    attrs: {},
    children: [],
    listeners: {},
    classes: new Set(),
    src: '',
    focusCount: 0,
    contentWindow: { postMessage: () => {} },
    focus() {
      e.focusCount++
    },
    setAttribute(k, v) {
      e.attrs[k] = v
    },
    getAttribute(k) {
      return k in e.attrs ? e.attrs[k] : null
    },
    removeAttribute(k) {
      delete e.attrs[k]
    },
    addEventListener(type, fn) {
      e.listeners[type] = fn
    },
    appendChild(c) {
      e.children.push(c)
    },
    classList: {
      add: (c) => void e.classes.add(c),
      remove: (c) => void e.classes.delete(c),
    },
  }
  let text = ''
  Object.defineProperty(e, 'textContent', {
    get: () => text,
    set: (v: string) => {
      text = v
      if (v === '') e.children.length = 0
    },
  })
  return e
}

async function ready() {
  const script = el('script')
  script.attrs['data-base-url'] = 'https://app.test'
  script.attrs['data-widget-id'] = TOKEN
  const head = el('head')
  const body = el('body')
  const docListeners: Record<string, (e: unknown) => void> = {}
  const winListeners: Record<string, (e: unknown) => void> = {}
  const sandbox: Record<string, unknown> = {
    document: {
      currentScript: script,
      readyState: 'complete',
      head,
      body,
      createElement: (tag: string) => el(tag),
      createElementNS: (_ns: string, tag: string) => el(tag),
      getElementsByTagName: () => [script],
      addEventListener: (type: string, fn: (e: unknown) => void) => (docListeners[type] = fn),
    },
    addEventListener: (type: string, fn: (e: unknown) => void) => (winListeners[type] = fn),
    location: { origin: 'https://customer.test' },
    URL,
    setTimeout,
    clearTimeout,
    Promise,
    AbortController,
    encodeURIComponent,
    Object,
    Date: { now: () => 1_700_000_000_000 },
    fetch: async () => ({ ok: true, json: async () => ({ token: TOKEN, display: {} }) }),
  }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox)
  await new Promise((r) => setTimeout(r, 20))
  const panel = () => body.children.find((c) => c.id === 'cp-widget-panel')!
  const bubble = () => body.children.find((c) => c.id === 'cp-widget-bubble')!
  const frame = () => panel().children.find((c) => c.tag === 'iframe')!
  const css = () => head.children.map((c) => c.textContent).join('')
  return {
    panel,
    bubble,
    frame,
    css,
    click: () => bubble().listeners.click(),
    key: (key: string) => docListeners.keydown?.({ key }),
    message: (event: { source: unknown; origin: string; data: unknown }) => winListeners.message?.(event),
  }
}

const CLOSE = { type: 'answerloops:close-panel' }

describe('public/widget.js: a closed panel is out of reach', () => {
  it('is inert and hidden from assistive tech until opened, and again once closed', async () => {
    const w = await ready()
    expect(w.panel().attrs.inert).toBe('')
    expect(w.panel().attrs['aria-hidden']).toBe('true')
    w.click()
    expect('inert' in w.panel().attrs).toBe(false)
    expect('aria-hidden' in w.panel().attrs).toBe(false)
    w.click()
    expect(w.panel().attrs.inert).toBe('')
    expect(w.panel().attrs['aria-hidden']).toBe('true')
  })

  it('becomes hidden (not just transparent) once it has faded out, and visible at once when opened', async () => {
    const w = await ready()
    const css = w.css()
    const closed = css.match(/#cp-widget-panel\{[^}]*\}/)![0]
    expect(closed).toContain('visibility:hidden')
    expect(closed).toMatch(/visibility 0s linear \.2s/)
    const open = css.match(/#cp-widget-panel\.cp-open\{[^}]*\}/)![0]
    expect(open).toContain('visibility:visible')
    expect(open).toContain('transition-delay:0s')
  })
})

describe('public/widget.js: the bubble says what it does', () => {
  it('names the action and reports whether the chat is open, pointing at the panel', async () => {
    const w = await ready()
    expect(w.bubble().attrs['aria-label']).toBe('Open support chat')
    expect(w.bubble().attrs['aria-expanded']).toBe('false')
    expect(w.bubble().attrs['aria-controls']).toBe('cp-widget-panel')
    w.click()
    expect(w.bubble().attrs['aria-label']).toBe('Close support chat')
    expect(w.bubble().attrs['aria-expanded']).toBe('true')
  })

  it('gives the panel and the chat frame the same name', async () => {
    const w = await ready()
    w.click()
    expect(w.panel().attrs.role).toBe('dialog')
    expect(w.panel().attrs['aria-label']).toBe('Support chat')
    expect(w.frame().title).toBe('Support chat')
  })
})

describe('public/widget.js: Esc', () => {
  it('on the page closes the open panel and puts focus back on the bubble', async () => {
    const w = await ready()
    w.click()
    w.key('Escape')
    expect(w.panel().classes.has('cp-open')).toBe(false)
    expect(w.bubble().focusCount).toBe(1)
  })

  it('does nothing while the panel is closed, so the page keeps its own Esc', async () => {
    const w = await ready()
    w.key('Escape')
    expect(w.bubble().focusCount).toBe(0)
    expect(w.panel().classes.has('cp-open')).toBe(false)
  })

  it('ignores other keys', async () => {
    const w = await ready()
    w.click()
    w.key('Enter')
    expect(w.panel().classes.has('cp-open')).toBe(true)
  })

  it('inside the chat: the close message from its own frame and origin closes the panel and focuses the bubble', async () => {
    const w = await ready()
    w.click()
    w.message({ source: w.frame().contentWindow, origin: 'https://app.test', data: CLOSE })
    expect(w.panel().classes.has('cp-open')).toBe(false)
    expect(w.bubble().focusCount).toBe(1)
  })

  it('ignores the close message from any other window or origin, and any other message', async () => {
    const w = await ready()
    w.click()
    w.message({ source: {}, origin: 'https://app.test', data: CLOSE })
    w.message({ source: w.frame().contentWindow, origin: 'https://evil.test', data: CLOSE })
    w.message({ source: w.frame().contentWindow, origin: 'https://app.test', data: { type: 'something-else' } })
    w.message({ source: w.frame().contentWindow, origin: 'https://app.test', data: 'answerloops:close-panel' })
    expect(w.panel().classes.has('cp-open')).toBe(true)
  })
})

describe('public/widget.js: reduced motion', () => {
  it('turns off the panel scale and fade and the bubble growing on hover', async () => {
    const w = await ready()
    const rule = w.css().match(/@media \(prefers-reduced-motion:reduce\)\{(.*)\}\}/)
    expect(rule).not.toBeNull()
    expect(rule![1]).toMatch(/#cp-widget-panel,#cp-widget-panel\.cp-open\{transition:none;transform:none;\}/)
    expect(rule![1]).toMatch(/#cp-widget-bubble,#cp-widget-bubble:hover\{transition:none;transform:none;/)
  })
})
