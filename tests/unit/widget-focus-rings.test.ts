import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

/**
 * Every control in the chat panel shows a clear keyboard focus indicator in the
 * brand focus color (--brand-focus: the brand color when it stands out on
 * white, otherwise near-black; see lib/widget/appearance.ts). The widget's
 * components are parsed, so a new button, link or field without one fails here.
 */

const DIR = path.join(process.cwd(), 'app/widget/[widgetToken]')
const CONTROLS = new Set(['button', 'a', 'input', 'textarea', 'select'])

interface Control {
  where: string
  tag: string
  className: string
}

function controls(): Control[] {
  const found: Control[] = []
  for (const name of fs.readdirSync(DIR).filter((f) => f.endsWith('.tsx'))) {
    const file = path.join(DIR, name)
    const src = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(src)
        if (CONTROLS.has(tag)) {
          const attr = node.attributes.properties.find(
            (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(src) === 'className'
          )
          found.push({
            where: `${name}:${src.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
            tag,
            className: attr?.initializer?.getText(src) ?? '',
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(src)
  }
  return found
}

describe('chat panel focus indicators', () => {
  it('finds the panel’s controls (so the scan itself is working)', () => {
    expect(controls().length).toBeGreaterThan(15)
  })

  it('gives every button and link a visible focus ring in the brand focus color, offset from the control', () => {
    const missing = controls()
      .filter((c) => c.tag === 'button' || c.tag === 'a')
      .filter((c) => !/focus-visible:ring-2/.test(c.className) || !/focus-visible:ring-brand-focus/.test(c.className) || !/focus-visible:ring-offset-2/.test(c.className))
      .map((c) => `${c.where} <${c.tag}>`)
    expect(missing).toEqual([])
  })

  it('gives every text field a focus border or ring in the brand focus color', () => {
    const missing = controls()
      .filter((c) => c.tag === 'input' || c.tag === 'textarea')
      .filter((c) => !/focus:border-brand-focus|focus:ring-brand-focus|focus-visible:ring-brand-focus/.test(c.className))
      .map((c) => `${c.where} <${c.tag}>`)
    expect(missing).toEqual([])
  })

  it('never uses the old faint ring colors', () => {
    const faint = controls()
      .filter((c) => /ring-brand-(100|400)\b/.test(c.className))
      .map((c) => c.where)
    expect(faint).toEqual([])
  })

  it('defines the focus color in the theme, with the default brand blue as its fallback', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'app/globals.css'), 'utf8')
    expect(css).toMatch(/--color-brand-focus:\s*var\(--brand-focus,\s*#2563eb\);/)
  })
})
