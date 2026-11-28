// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { Message } from '@ag-ui/client'
import { saveTranscript } from '@/lib/widget/transcript'

/**
 * Keyboard and screen-reader behavior inside WidgetChat: Esc asks the embed to
 * close the panel, each finished reply is read out once (not each streamed
 * piece, not a reply restored from earlier, not again after a failed run), the
 * "session timed out" message is announced, and the email fields are named.
 * The agent is faked as in widget-chat-component.test.tsx.
 */

type Subscriber = {
  onEvent?: (p: { messages: Message[] }) => void
  onRunInitialized?: () => void
  onRunFinalized?: () => void
  onRunFailed?: (p: { error: Error }) => void
}

function makeFakeAgent() {
  let messages: Message[] = []
  let subscriber: Subscriber | undefined
  return {
    agent: {
      get messages() {
        return messages
      },
      addMessage: vi.fn((m: Message) => {
        messages = [...messages, m]
      }),
      setMessages: vi.fn((m: Message[]) => {
        messages = m
      }),
      runAgent: vi.fn(async () => {}),
      subscribe: vi.fn((s: Subscriber) => {
        subscriber = s
        return { unsubscribe: vi.fn() }
      }),
    },
    event: (msgs: Message[]) =>
      act(() => {
        messages = msgs
        subscriber?.onEvent?.({ messages: msgs })
      }),
    started: () => act(() => subscriber?.onRunInitialized?.()),
    finished: () => act(() => subscriber?.onRunFinalized?.()),
    failed: () =>
      act(() => {
        subscriber?.onRunFailed?.({ error: new Error('HTTP 500: x') })
        subscriber?.onRunFinalized?.()
      }),
  }
}

const h = vi.hoisted(() => ({ current: null as ReturnType<typeof makeFakeAgent> | null }))

vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })))
vi.mock('@copilotkit/react-core/v2', () => ({
  CopilotKitProvider: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock('@copilotkit/react-core/v2/headless', () => ({
  useAgent: () => ({ agent: h.current!.agent, isReady: true }),
  useRenderTool: () => {},
  useRenderToolCall: () => vi.fn(() => null),
}))

const TOKEN = 'a'.repeat(48)

async function renderWidget(leadCaptureMode: 'off' | 'up-front' | 'on-failure' = 'off') {
  const fake = makeFakeAgent()
  h.current = fake
  const { WidgetChat } = await import('@/app/widget/[widgetToken]/widget-chat')
  render(<WidgetChat widgetToken={TOKEN} renderToken="test-render-token" orgName="Acme" showBranding isSelfPreview={false} leadCaptureMode={leadCaptureMode} />)
  return fake
}

const announcer = () => screen.getByTestId('reply-announcer')

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  sessionStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  Object.defineProperty(window, 'parent', { value: window, configurable: true })
  vi.restoreAllMocks()
})

describe('WidgetChat: Esc', () => {
  it('asks the embed to close the panel, with nothing but the message type', async () => {
    const postMessage = vi.fn()
    Object.defineProperty(window, 'parent', { value: { postMessage }, configurable: true })
    await renderWidget()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(postMessage).toHaveBeenCalledWith({ type: 'answerloops:close-panel' }, '*')
  })

  it('does nothing when the chat is open in its own tab, or for other keys', async () => {
    const postMessage = vi.fn()
    await renderWidget()
    fireEvent.keyDown(document, { key: 'Escape' })
    Object.defineProperty(window, 'parent', { value: { postMessage }, configurable: true })
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(postMessage).not.toHaveBeenCalled()
  })
})

describe('WidgetChat: replies read out to screen readers', () => {
  it('reads the reply once it has finished, not while it streams', async () => {
    const fake = await renderWidget()
    expect(announcer()).toHaveAttribute('aria-live', 'polite')
    await fake.started()
    await fake.event([
      { id: 'u1', role: 'user', content: 'q' },
      { id: 'a1', role: 'assistant', content: 'Open Settings' },
    ] as Message[])
    expect(announcer().textContent).toBe('')
    await fake.event([
      { id: 'u1', role: 'user', content: 'q' },
      { id: 'a1', role: 'assistant', content: 'Open Settings and choose Export.' },
    ] as Message[])
    await fake.finished()
    expect(announcer().textContent).toBe('Reply: Open Settings and choose Export.')
  })

  it('reads nothing for a failed run, not even its partial text or the last reply', async () => {
    const fake = await renderWidget()
    await fake.started()
    await fake.event([
      { id: 'u1', role: 'user', content: 'q' },
      { id: 'a1', role: 'assistant', content: 'First answer.' },
    ] as Message[])
    await fake.finished()
    expect(announcer().textContent).toBe('Reply: First answer.')

    await fake.started()
    await fake.event([
      { id: 'u1', role: 'user', content: 'q' },
      { id: 'a1', role: 'assistant', content: 'First answer.' },
      { id: 'u2', role: 'user', content: 'q2' },
      { id: 'a2', role: 'assistant', content: 'Half a sent' },
    ] as Message[])
    await fake.failed()
    expect(announcer().textContent).toBe('')
  })

  it('does not read an earlier reply again when a run adds no new text', async () => {
    const fake = await renderWidget()
    await fake.started()
    await fake.event([
      { id: 'u1', role: 'user', content: 'q' },
      { id: 'a1', role: 'assistant', content: 'First answer.' },
    ] as Message[])
    await fake.finished()

    await fake.started()
    await fake.event([
      { id: 'u1', role: 'user', content: 'q' },
      { id: 'a1', role: 'assistant', content: 'First answer.' },
      { id: 'u2', role: 'user', content: 'show me' },
      { id: 'a2', role: 'assistant', content: '' },
    ] as Message[])
    await fake.finished()
    expect(announcer().textContent).toBe('')
  })

  it('reads a new reply even when its words match the previous one', async () => {
    const fake = await renderWidget()
    await fake.started()
    await fake.event([{ id: 'a1', role: 'assistant', content: 'Done.' }] as Message[])
    await fake.finished()
    await fake.started()
    expect(announcer().textContent).toBe('')
    await fake.event([
      { id: 'a1', role: 'assistant', content: 'Done.' },
      { id: 'a2', role: 'assistant', content: 'Done.' },
    ] as Message[])
    await fake.finished()
    expect(announcer().textContent).toBe('Reply: Done.')
  })

  it('does not read out a conversation restored from an earlier visit', async () => {
    saveTranscript(TOKEN, [
      { id: 'u0', role: 'user', content: 'Earlier question' },
      { id: 'a0', role: 'assistant', content: 'Earlier answer.' },
    ] as Message[])
    await renderWidget()
    expect(screen.getByText('Earlier answer.')).toBeTruthy()
    expect(announcer().textContent).toBe('')
  })
})

describe('WidgetChat: names and announcements', () => {
  it('names the up-front email field', async () => {
    await renderWidget('up-front')
    expect(screen.getByRole('textbox', { name: 'Your email' })).toBeTruthy()
  })

  it('announces the "session timed out" message', async () => {
    const fake = await renderWidget()
    // A recovery a moment ago sends this refusal to the timed-out screen.
    sessionStorage.setItem(`al_recovered:${TOKEN}`, String(Date.now()))
    await fake.started()
    act(() => {
      ;(h.current!.agent.subscribe.mock.calls[0][0] as Subscriber).onRunFailed?.({ error: new Error('HTTP 403: Forbidden') })
    })
    const message = screen.getByTestId('session-expired').querySelector('output')!
    expect(message).toHaveAttribute('aria-live', 'polite')
    expect(message.textContent).toMatch(/timed out/)
  })
})
