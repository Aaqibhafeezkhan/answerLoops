import fs from 'fs'
import postgres from 'postgres'
import { test, expect, type Page } from '@playwright/test'
import { WIDGET_TOKEN_FILE } from './global-setup'
import { DEFAULT_ORG_ID } from '../lib/db/schema'

// Keyboard use of the embedded widget in a real browser: a stand-in customer
// page loads public/widget.js (served from the app under test through a second
// host name, as in widget-question-box.spec.ts). Tab never reaches the closed
// panel, Esc closes it from inside the chat or from the page and returns focus
// to the bubble, controls show a focus ring, and reduced motion removes the
// panel animation.

const CUSTOMER_HOST = 'customer.localhost'
const CUSTOMER_PAGE = `http://${CUSTOMER_HOST}/help`
const APP = 'http://app.localhost'
const sql = postgres(process.env.DATABASE_URL!, { max: 1 })
let previous: { widget_allowed_origins: string | null; widget_lead_capture_mode: string } | null = null

test.beforeAll(async () => {
  const [row] = await sql`select widget_allowed_origins, widget_lead_capture_mode from orgs where id = ${DEFAULT_ORG_ID}`
  previous = row as typeof previous
  await sql`update orgs set widget_allowed_origins = ${CUSTOMER_HOST}, widget_lead_capture_mode = 'off' where id = ${DEFAULT_ORG_ID}`
})

test.afterAll(async () => {
  if (previous) {
    await sql`update orgs set widget_allowed_origins = ${previous.widget_allowed_origins}, widget_lead_capture_mode = ${previous.widget_lead_capture_mode} where id = ${DEFAULT_ORG_ID}`
  }
  await sql.end()
})

function token(): string {
  return (JSON.parse(fs.readFileSync(WIDGET_TOKEN_FILE, 'utf-8')) as { token: string }).token
}

async function openCustomerPage(page: Page, baseURL: string) {
  await page.route(`${APP}/**`, async (route) => {
    const url = new URL(route.request().url())
    try {
      const response = await route.fetch({ url: `${baseURL}${url.pathname}${url.search}` })
      await route.fulfill({ response })
    } catch {
      // A request still in flight when the test finished.
    }
  })
  await page.route(CUSTOMER_PAGE, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><h1>Help</h1><a id="before" href="#top">Before</a><script src="${APP}/widget.js" data-widget-id="${token()}" data-base-url="${APP}"></script></body></html>`,
    })
  )
  await page.goto(CUSTOMER_PAGE)
  await expect(page.locator('#cp-widget-bubble')).toBeVisible()
}

const panelOpen = (page: Page) => page.locator('#cp-widget-panel').evaluate((el) => el.classList.contains('cp-open'))
const activeId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? document.activeElement?.tagName)

test.describe('widget keyboard use', () => {
  test('Tab never reaches the closed panel, even once the chat has been opened and closed', async ({ page, baseURL }) => {
    await openCustomerPage(page, baseURL!)
    // Open once so the chat frame exists, then close it again.
    await page.locator('#cp-widget-bubble').click()
    await expect(page.frameLocator('#cp-widget-panel iframe').getByRole('textbox', { name: 'Your question' })).toBeVisible({ timeout: 30_000 })
    await page.locator('#cp-widget-bubble').click()
    await expect.poll(() => panelOpen(page)).toBe(false)

    await page.locator('#before').focus()
    await page.keyboard.press('Tab')
    expect(await activeId(page)).toBe('cp-widget-bubble')
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('IFRAME')
  })

  test('opening with the keyboard, then Esc inside the chat, closes it and focuses the bubble', async ({ page, baseURL }) => {
    await openCustomerPage(page, baseURL!)
    await page.locator('#cp-widget-bubble').focus()
    await page.keyboard.press('Enter')
    const box = page.frameLocator('#cp-widget-panel iframe').getByRole('textbox', { name: 'Your question' })
    await expect(box).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('#cp-widget-bubble')).toHaveAttribute('aria-expanded', 'true')

    await box.focus()
    await box.press('Escape')
    await expect.poll(() => panelOpen(page)).toBe(false)
    expect(await activeId(page)).toBe('cp-widget-bubble')
    await expect(page.locator('#cp-widget-bubble')).toHaveAttribute('aria-expanded', 'false')
  })

  test('Esc on the page closes the open chat and focuses the bubble', async ({ page, baseURL }) => {
    await openCustomerPage(page, baseURL!)
    await page.locator('#cp-widget-bubble').click()
    await expect.poll(() => panelOpen(page)).toBe(true)
    await page.locator('#before').focus()
    await page.keyboard.press('Escape')
    await expect.poll(() => panelOpen(page)).toBe(false)
    expect(await activeId(page)).toBe('cp-widget-bubble')
  })

  test('controls in the chat show a focus ring when reached with the keyboard', async ({ page, baseURL }) => {
    await openCustomerPage(page, baseURL!)
    await page.locator('#cp-widget-bubble').click()
    const chat = page.frameLocator('#cp-widget-panel iframe')
    const box = chat.getByRole('textbox', { name: 'Your question' })
    await expect(box).toBeVisible({ timeout: 30_000 })
    await box.fill('hello')
    await box.press('Tab')
    const send = chat.getByRole('button', { name: 'Send message' })
    await expect(send).toBeFocused()
    expect(await send.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none')
  })

  test('with reduced motion, the panel opens without scaling or fading', async ({ page, baseURL }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openCustomerPage(page, baseURL!)
    const panel = page.locator('#cp-widget-panel')
    const style = await panel.evaluate((el) => ({ duration: getComputedStyle(el).transitionDuration, transform: getComputedStyle(el).transform }))
    expect(style.duration.split(',').every((d) => d.trim() === '0s')).toBe(true)
    expect(style.transform).toBe('none')
  })
})
