import React from 'react'
import { createRoot } from 'react-dom/client'

const registered = new Map()
let plugin
let draft = ''
let revision = 0
const sessionId = 'test-session'
const attachments = []
const references = []
const sentMessages = []
let nextAttachmentId = 0
const actions = {
  captureInsertion: () => ({ start: draft.length, end: draft.length, draftRev: revision }),
  insertText(text, span) { if (span.draftRev !== revision) return false; draft = draft.slice(0, span.start) + text + draft.slice(span.end); revision++; document.querySelector('#draft').textContent = draft; return true },
  addAttachments(ids) { attachments.push(...ids); return true },
  removeAttachment(id) { const index = attachments.indexOf(id); if (index < 0) return false; attachments.splice(index, 1); return true }
}
window.__ModuleLoader__ = { load({ factory }) { plugin = factory(name => { if (name === 'react') return React; throw Error(`unexpected module: ${name}`) }) } }
const ctx = {
  effect(fn) { return fn() },
  inject(_names, fn) { const dispose = fn({ get: name => ctx[name] }); return { dispose: dispose || (() => {}) } },
  documentPreviews: { register(descriptor) { registered.set('preview:' + descriptor.id, descriptor); return () => {} } },
  sidebarRightTabs: { register(descriptor) { registered.set('tab:' + descriptor.id, descriptor); return () => {} } },
  sidebarRight: { mounted: { getSnapshot: () => sessionId }, openTab(kind) { document.querySelector('#open-result').textContent = kind } },
  inputTriggers: { sources: [], registerSource(source) { this.sources.push(source); return () => {} } },
  sessions: { scope: () => ({ bail: () => true }), binding: id => id === sessionId ? { sessionId, session: { sessionId } } : undefined },
  conversation: {
    drafts: new Map(),
    createDrafts(_sessionId, files) { return files.map(file => { const id = `image-${++nextAttachmentId}`; this.drafts.set(id, { id, file }); return { id } }) },
    releaseDraftAttachment(id) { this.drafts.delete(id) },
    sendAttempts: 0,
    failNextSend: 0,
    sendDelay: 0,
    async sendSession(session, text, ids, mode, signal) {
      this.sendAttempts++
      if (this.sendDelay) await new Promise(resolve => setTimeout(resolve, this.sendDelay))
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      if (this.failNextSend > 0) { this.failNextSend--; throw new Error('Test send failure') }
      const files = ids.map(id => this.drafts.get(id)?.file)
      if (files.some(file => !file)) throw new Error('Image not ready')
      sentMessages.push({ sessionId: session.sessionId, text, attachmentIds: [...ids], files, mode })
      for (const id of ids) this.releaseDraftAttachment(id)
      return { kind: 'success' }
    }
  },
  slots: { inject(_name, fn) { return fn() }, register(options, component) { registered.set(`${options.name}:${options.key || options.id}`, { options, component }); return () => {} } }
}
window.startHarness = async function() {
  plugin.apply(ctx)
  const bytes = new Uint8Array(await (await fetch('/paper.pdf')).arrayBuffer())
  const DocumentBody = registered.get('sidebar.right.tab.document:dsh-paper-reader/pdf').component
  const bridgeRegistration = registered.get('conversation.input.left:dsh-paper-reader:input')
  const Bridge = bridgeRegistration.component
  const LocalBody = registered.get('sidebar.right.pane.tab:dsh-paper-reader/local').component
  const HeaderButton = registered.get('conversation.session.header.utilities:dsh-paper-reader:open').component
  const root = createRoot(document.querySelector('#app'))
  const bridgeProps = {
    ...bridgeRegistration.options.inject(sessionId),
    sessionId, inputActions: actions,
    createDrafts: files => ctx.conversation.createDrafts(sessionId, files),
    releaseDraftAttachment: id => ctx.conversation.releaseDraftAttachment(id),
    insertReference(reference, span) {
      if (span.draftRev !== revision) return false
      references.push(reference)
      draft = `${draft.slice(0, span.start)}@${reference.label} ${draft.slice(span.end)}`
      revision++
      document.querySelector('#draft').textContent = draft
      return true
    }
  }
  // copy: simulate a host that hands over the same file as a new Uint8Array on re-render.
  const renderDocument = ({ copy = false } = {}) => root.render(<><Bridge {...bridgeProps}/><DocumentBody resourceAddress="dsh-resource://file/session/test-session/paper.pdf" content={{kind:'bytes',data:copy ? bytes.slice() : bytes}} useTabInfo={() => ({ tab: { title:'SuperMimic.pdf' } })}/></>)
  const renderLocal = () => root.render(<><Bridge {...bridgeProps}/><HeaderButton sessionId={sessionId} sidebar={ctx.sidebarRight}/><LocalBody sessionId={sessionId}/></>)
  renderDocument()
  window.testHarness = { registered, actions, attachments, references, sentMessages, inputTriggers: ctx.inputTriggers, conversation: ctx.conversation, renderLocal, renderDocument, lateActivation: runLateServiceTest, getDraft: () => draft, setDraft: value => { draft = value; revision++; document.querySelector('#draft').textContent = draft } }
  if (new URLSearchParams(location.search).has('autotest')) {
    const deadline = Date.now() + 15000
    let title
    while (!(title = [...document.querySelectorAll('[data-pdf-page="1"] .pr-text-layer span')].find(node => node.textContent.includes('SuperMimic:')))) {
      if (Date.now() > deadline) throw new Error('PDF title text layer did not render')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const range = document.createRange()
    range.selectNodeContents(title)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    await new Promise(resolve => setTimeout(resolve, 100))
    document.querySelector('.pr-selection-menu button')?.click()
    await new Promise(resolve => setTimeout(resolve, 100))
    const result = document.createElement('pre')
    result.id = 'paper-test-result'
    result.textContent = JSON.stringify({ pages: document.querySelectorAll('[data-pdf-page]').length, draft, notice: document.querySelector('.pr-notice')?.textContent })
    document.body.appendChild(result)
  }
}

function runLateServiceTest() {
  const localRegistered = new Map()
  const listeners = new Set()
  const services = {}
  const lateCtx = {
    effect(fn) { return fn() },
    inject(names, fn) {
      const entry = { names, fn }
      listeners.add(entry)
      const dispose = names.every(name => services[name]) ? fn({ get: key => services[key] }) : undefined
      return { dispose: dispose || (() => {}) }
    },
    slots: {
      inject(_name, fn) { return fn() },
      register(options, component) { localRegistered.set(`${options.name}:${options.key || options.id}`, { options, component }); return () => {} }
    }
  }
  plugin.apply(lateCtx)
  const quietWithoutServices = !localRegistered.has('conversation.input.left:dsh-paper-reader:input') && !localRegistered.has('preview:dsh-paper-reader/pdf') && !localRegistered.has('tab:dsh-paper-reader/local')
  const provide = (name, service) => {
    services[name] = service
    for (const entry of listeners) if (entry.names.every(required => services[required])) entry.fn({ get: key => services[key] })
  }
  provide('conversation', ctx.conversation)
  provide('sessions', ctx.sessions)
  const inputAfterLateService = localRegistered.has('conversation.input.left:dsh-paper-reader:input')
  provide('documentPreviews', { register(descriptor) { localRegistered.set('preview:' + descriptor.id, descriptor); return () => {} } })
  const previewAfterLateService = localRegistered.has('preview:dsh-paper-reader/pdf') && localRegistered.has('sidebar.right.tab.document:dsh-paper-reader/pdf')
  provide('sidebarRightTabs', { register(descriptor) { localRegistered.set('tab:' + descriptor.id, descriptor); return () => {} } })
  const tabAfterLateService = localRegistered.has('tab:dsh-paper-reader/local') && localRegistered.has('sidebar.right.pane.tab:dsh-paper-reader/local')
  provide('sidebarRight', ctx.sidebarRight)
  const buttonAfterLateService = localRegistered.has('conversation.session.header.utilities:dsh-paper-reader:open')
  return { inputAfterLateService, quietWithoutServices, previewAfterLateService, tabAfterLateService, buttonAfterLateService }
}
