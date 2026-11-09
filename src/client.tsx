import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PdfReader, type PdfQuote, type PdfReaderAction } from './PdfReader'
import { ReaderIcon } from './icons'
import { createDraftRequest, createReferenceDraftRequest, createFigureDraftRequest, insertInlineReferenceDraft, retryDraftInsertion, copyDraftRequest, serializeInlineQuote, type DraftBinding, type DraftRequest, type DraftQuoteReference, type InsertionSpan } from './draftBridge'
import { buildNotesPrompt } from './notesPrompt.mjs'
import { sendReadingRequest, type ReadingSendRequest } from './sendBridge'
import css from './pdf-reader.css'
import workerSource from 'pdf-worker-source'
import { closeAllPdfDocuments } from './documentStore'
import { pdfContentKey } from './contentKey'
import { disposePdfWorker } from './pdfWorker'
import { installTrace, uninstallTrace } from './trace'

const READER_ID = 'dsh-paper-reader/pdf'
const LOCAL_TAB_ID = 'dsh-paper-reader/local'
const LOCAL_TAB_KIND = 'dsh-paper-reader-local'
const bindings = new Map<string, DraftBinding>()
let workerURL = ''

function decodeFileAddress(address: unknown): { sessionId: string; path: string } | undefined {
  if (typeof address !== 'string' || !address.startsWith('dsh-resource://file/session/')) return undefined
  const parts = address.slice('dsh-resource://file/session/'.length).split(/[?#]/, 1)[0].split('/')
  if (parts.length < 2) return undefined
  try {
    const sessionId = decodeURIComponent(parts.shift()!)
    const path = parts.map(decodeURIComponent).join('/')
    return sessionId && path ? { sessionId, path } : undefined
  } catch { return undefined }
}
function baseName(path: string): string { return path.split(/[\\/]/).pop() || path }

/** A slot is mounted for the actual conversation input, so bindings never point to another session. */
function InputBridge(props: { sessionId?: string; inputActions?: DraftBinding['inputActions']; createDrafts?: DraftBinding['createDrafts']; releaseDraftAttachment?: DraftBinding['releaseDraftAttachment']; insertReference?: DraftBinding['insertReference']; sendMessage?: DraftBinding['sendMessage'] }) {
  const { sessionId, inputActions, createDrafts, releaseDraftAttachment, insertReference, sendMessage } = props
  useEffect(() => {
    if (!sessionId || !inputActions) return
    const binding: DraftBinding = { sessionId, inputActions, createDrafts, releaseDraftAttachment, insertReference, sendMessage }
    bindings.set(sessionId, binding)
    return () => { if (bindings.get(sessionId) === binding) bindings.delete(sessionId) }
  }, [sessionId, inputActions, createDrafts, releaseDraftAttachment, insertReference, sendMessage])
  return null
}

async function copyFigureImage(image: Blob, fallbackText: string): Promise<'image' | 'text' | 'failed'> {
  try {
    if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([new ClipboardItem({ [image.type || 'image/png']: image })])
      return 'image'
    }
  } catch { /* fall through to a text copy */ }
  try {
    if (!navigator.clipboard?.writeText) return 'failed'
    await navigator.clipboard.writeText(fallbackText)
    return 'text'
  } catch { return 'failed' }
}

function ReaderShell({ data, fileName, sessionId, stateKey }: { data: Uint8Array; fileName: string; sessionId: string; stateKey?: string }) {
  // Same bytes as a new array (host re-render) must not reset pending retries.
  const contentKey = useMemo(() => pdfContentKey(data), [data])
  const [pending, setPending] = useState<DraftRequest | null>(null)
  const [pendingSend, setPendingSend] = useState<ReadingSendRequest | null>(null)
  const activeSend = useRef<AbortController | null>(null)
  const [notice, setNotice] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const statusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lifetime = useRef(0)
  const clearStatusTimer = useCallback(() => {
    if (statusTimer.current !== undefined) clearTimeout(statusTimer.current)
    statusTimer.current = undefined
  }, [])
  useEffect(() => {
    lifetime.current++
    setPending(null)
    setPendingSend(null)
    setNotice('')
    setStatusMessage('')
    clearStatusTimer()
    return () => { lifetime.current++; activeSend.current?.abort(); activeSend.current = null; clearStatusTimer() }
  }, [contentKey, sessionId, stateKey, clearStatusTimer])
  const showStatus = useCallback((message: string, transient = true, keepNotice = false) => {
    clearStatusTimer()
    if (!keepNotice) setNotice('')
    const compact: Record<string, string> = {
      '笔记生成指令已插入草稿，请检查后发送。': '笔记指令已加入草稿',
      '图表截图和解释请求已插入草稿，请检查后发送。': '已加入草稿',
      '已插入当前会话草稿，请检查后发送。': '已加入草稿',
      '已插入内联引用，完整选段会在发送时展开。': '引用已加入草稿',
      '已复制选中文字。': '已复制',
      '已复制图表截图。': '已复制图表',
      '已复制引用与问题。': '已复制引用',
      '正在把图表添加到当前会话…': '正在添加图表…',
      '正在添加内联选段引用…': '正在添加引用…',
    }
    setStatusMessage(compact[message] || message)
    if (transient) statusTimer.current = setTimeout(() => { statusTimer.current = undefined; setStatusMessage('') }, 2000)
  }, [clearStatusTimer])
  const showError = useCallback((message: string) => {
    clearStatusTimer()
    setStatusMessage('')
    setNotice(message)
  }, [clearStatusTimer])
  const sendSelected = useCallback((selected: ReadingSendRequest) => {
    if (activeSend.current) { showStatus('正在发送，请稍候…', false, true); return }
    const generation = lifetime.current
    const binding = bindings.get(sessionId)
    const controller = new AbortController()
    activeSend.current = controller
    showStatus('正在发送…', false)
    void sendReadingRequest(selected, binding, {
      signal: controller.signal,
      isCurrent: () => lifetime.current === generation && bindings.get(sessionId) === binding,
    }).then(result => {
      if (lifetime.current !== generation) return
      if (result.status === 'sent') { setPendingSend(null); showStatus('已发送') }
      else {
        setPendingSend(selected)
        showError(result.status === 'pending' && result.reason === 'send-unavailable'
          ? '当前宿主的发送接口不可用，内容已保留，可重试或复制。'
          : result.status === 'cancelled' ? '会话输入框已变化，本次未发送，内容已保留，可重试。'
          : '发送失败，内容已保留，可重试或复制。')
      }
    }).finally(() => { if (activeSend.current === controller) activeSend.current = null })
  }, [sessionId, showError, showStatus])

  const act = useCallback((action: PdfReaderAction, quote: PdfQuote) => {
    const generation = lifetime.current
    const isCurrent = () => lifetime.current === generation
    if (quote.kind === 'figure') {
      const selection = { sessionId, fileName, page: quote.pageStart, pageEnd: quote.pageEnd, text: quote.text }
      const request = createFigureDraftRequest(selection)
      const fallbackText = `来源：${fileName}，第 ${quote.pageStart}${quote.pageEnd !== quote.pageStart ? `–${quote.pageEnd}` : ''} 页\n\n${quote.text}`
      const image = quote.image
      const copy = async (success: string, failure: string, attachmentFailed = false) => {
        if (!image) { showError('未能截取图表，请尝试放大后重试。'); return }
        const result = await copyFigureImage(image, fallbackText)
        if (!isCurrent()) return
        if (result === 'image' && !attachmentFailed) showStatus(success, true, !!(pending || pendingSend))
        else showError(result === 'image' ? success : result === 'text' ? '无法复制图片，已复制图注与来源。' : failure)
      }
      if (action === 'copy') { void copy('已复制图表截图。', '复制图表失败，请手动截图。'); return }
      if (action !== 'explain') return
      if (pending || pendingSend) { showError('请先重试或放弃此前未完成的操作。'); return }
      if (!image) { showError('未能截取图表，请尝试放大后重试。'); return }
      sendSelected({ request, image: { blob: image, fileName: `${fileName.replace(/\.pdf$/i, '')}-第${quote.pageStart}页图表.png` } })
      return
    }
    if (action === 'copy') {
      if (!navigator.clipboard?.writeText) { showError('无法访问剪贴板，请手动复制选中文字。'); return }
      void navigator.clipboard.writeText(quote.text).then(() => { if (isCurrent()) showStatus('已复制选中文字。', true, !!(pending || pendingSend)) }, () => { if (isCurrent()) showError('复制失败，请手动复制选中文字。') })
      return
    }
    if (pending || pendingSend) { showError('请先重试或放弃此前未完成的操作。'); return }
    const selection = { sessionId, fileName, page: quote.pageStart, pageEnd: quote.pageEnd, text: quote.text }
    const fullRequest = createDraftRequest(selection, action)
    if (action === 'explain' || action === 'translate') {
      if (quote.image) {
        // A formula: the typeset image travels with the text so the model reads the real notation.
        const request: DraftRequest = { ...fullRequest, text: `${fullRequest.text}\n\n（附图为该选段在 PDF 中的原始排版，其中的公式请以图片为准。）` }
        sendSelected({ request, image: { blob: quote.image, fileName: `${fileName.replace(/\.pdf$/i, '')}-第${quote.pageStart}页公式.png` } })
        return
      }
      sendSelected({ request: fullRequest }); return
    }
    const insertFallback = () => {
      if (!isCurrent()) return
      const fallback = retryDraftInsertion(fullRequest, bindings.get(sessionId))
      if (fallback.status === 'inserted') { setPending(null); showStatus('内联引用不可用，已改为插入完整原文。') }
      else { setPending(fullRequest); showError('内联引用不可用，完整选段已保留，可重试或复制。') }
    }
    if (quote.text.length > 240 || quote.text.split(/\r?\n/).length > 3) {
      const referenceRequest = createReferenceDraftRequest(selection, action)
      showStatus('正在添加内联选段引用…', false)
      void insertInlineReferenceDraft(referenceRequest, bindings.get(sessionId)).then(result => {
        if (!isCurrent()) return
        if (result.status === 'inserted') { setPending(null); showStatus('已插入内联引用，完整选段会在发送时展开。') }
        else if (result.referenceInserted) { setPending(null); showError('引用已插入，请手动补充指令。') }
        else insertFallback()
      }, insertFallback)
      return
    }
    const result = retryDraftInsertion(fullRequest, bindings.get(sessionId))
    if (result.status === 'inserted') { setPending(null); showStatus('已插入当前会话草稿，请检查后发送。') }
    else { setPending(fullRequest); showError('暂时无法插入草稿。选段已保留，可重试或复制。') }
  }, [fileName, sessionId, pending, pendingSend, sendSelected, showError, showStatus])
  const generateNotes = useCallback(() => {
    const prompt = buildNotesPrompt(fileName)
    const request: DraftRequest = { selection: { sessionId, fileName, page: 1, text: prompt }, action: 'ask', text: prompt }
    const result = retryDraftInsertion(request, bindings.get(sessionId))
    if (result.status === 'inserted') showStatus('笔记生成指令已插入草稿，请检查后发送。')
    else showError('暂时无法插入草稿。请确认当前会话的输入框可用后重试。')
  }, [fileName, sessionId, showError, showStatus])
  return <div className="pr-shell" onPointerDownCapture={event => { event.currentTarget.dataset.inputMethod = 'pointer' }} onKeyDownCapture={event => { event.currentTarget.dataset.inputMethod = 'keyboard' }}>
    <PdfReader data={data} fileName={fileName} sessionId={sessionId} stateKey={stateKey} workerSrc={workerURL} onAction={act} statusMessage={statusMessage} onGenerateNotes={generateNotes}/>
    {notice && <div className="pr-notice" role="status"><span>{notice}</span>
      {pending && <><button type="button" onClick={() => { const result = retryDraftInsertion(pending, bindings.get(sessionId)); if (result.status === 'inserted') { setPending(null); showStatus('已插入当前会话草稿，请检查后发送。') } else showError('草稿仍不可用，选段已保留。') }}><ReaderIcon name="retry"/>重试</button><button type="button" onClick={() => {
        const generation = lifetime.current
        void copyDraftRequest(pending, navigator.clipboard?.writeText?.bind(navigator.clipboard)).then(result => {
          if (lifetime.current !== generation) return
          if (result.status === 'copied') showStatus('已复制引用与问题。', true, true)
          else showError('无法访问剪贴板，请稍后重试。')
        })
      }}>复制引用</button></>}
      {pendingSend && <><button type="button" onClick={() => sendSelected(pendingSend)}><ReaderIcon name="retry"/>重试发送</button><button type="button" onClick={() => {
        const generation = lifetime.current
        const selected = pendingSend
        const copied = selected.image
          ? copyFigureImage(selected.image.blob, createDraftRequest(selected.request.selection, 'explain').text)
          : copyDraftRequest(selected.request, navigator.clipboard?.writeText?.bind(navigator.clipboard)).then(result => result.status === 'copied' ? 'text' : 'failed')
        void copied.then(result => {
          if (lifetime.current !== generation) return
          if (result === 'failed') showError('无法访问剪贴板，内容仍保留，可重试发送。')
          else if (selected.image && result === 'text') showError('图片未能复制，已复制来源和图注；仍可重试发送图片。')
          else showStatus(result === 'image' ? '已复制图表' : '已复制引用', true, true)
        })
      }}>复制内容</button><button type="button" onClick={() => { setPendingSend(null); setNotice('') }}>放弃</button></>}
      {!pending && !pendingSend && <button className="pr-notice-close" type="button" aria-label="关闭提示" onClick={() => setNotice('')}><ReaderIcon name="close"/></button>}
      {pending && <button type="button" aria-label="放弃这段引用" onClick={() => { setPending(null); setNotice('') }}>放弃</button>}
    </div>}
  </div>
}

function DocumentBody(props: { resourceAddress?: string; content?: { kind?: string; data?: Uint8Array }; useTabInfo?: () => { tab?: { title?: string } } }) {
  const info = props.useTabInfo?.()
  const file = decodeFileAddress(props.resourceAddress)
  if (!file) return <div className="pr-empty" role="alert">无法识别 PDF 所属会话，已停止打开。</div>
  if (props.content?.kind !== 'bytes' || !(props.content.data instanceof Uint8Array)) return <div className="pr-empty" role="alert">未能读取 PDF 文件数据，请使用原有预览器重试。</div>
  return <ReaderShell key={props.resourceAddress} data={props.content.data} sessionId={file.sessionId} stateKey={props.resourceAddress} fileName={info?.tab?.title || baseName(file.path)}/>
}

function LocalFileBody(props: { sessionId?: string; useTabInfo?: () => any }) {
  const info = props.useTabInfo?.()
  const sessionId = props.sessionId || info?.sessionId || info?.tab?.sessionId
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array; generation: number } | null>(null)
  const [error, setError] = useState('')
  const serial = useRef(0)
  useEffect(() => () => { serial.current++ }, [])
  const pick = async (selected?: File) => {
    if (!selected) return
    const request = ++serial.current
    setError('')
    try {
      const bytes = new Uint8Array(await selected.arrayBuffer())
      if (serial.current === request) setFile({ name: selected.name, bytes, generation: request })
    } catch { if (serial.current === request) setError('无法读取该文件，请重新选择。') }
  }
  if (!sessionId || typeof sessionId !== 'string') return <div className="pr-empty" role="alert">无法识别当前会话，无法安全打开论文。</div>
  return <div className="pr-local" onPointerDownCapture={event => { event.currentTarget.dataset.inputMethod = 'pointer' }} onKeyDownCapture={event => { event.currentTarget.dataset.inputMethod = 'keyboard' }}>
    <div className="pr-local-toolbar"><label className="pr-file-button"><ReaderIcon name="document"/>选择本地 PDF<input type="file" accept="application/pdf,.pdf" onChange={event => { void pick(event.currentTarget.files?.[0]); event.currentTarget.value = '' }}/></label><span>选择 Zotero 或其他文件夹中的论文；刷新后需重新选择。</span></div>
    {error && <div className="pr-empty" role="alert">{error}</div>}
    {file ? <ReaderShell key={`${sessionId}:${file.generation}`} data={file.bytes} fileName={file.name} sessionId={sessionId}/> : <div className="pr-empty">选择 PDF 后在这里阅读，选中文字可引用到当前对话。</div>}
  </div>
}

function NotesButton({ sessionId }: { sessionId?: string }) {
  const [error, setError] = useState('')
  return <span className="pr-open-local" onPointerDownCapture={event => { event.currentTarget.dataset.inputMethod = 'pointer' }} onKeyDownCapture={event => { event.currentTarget.dataset.inputMethod = 'keyboard' }}><button type="button" title="生成阅读笔记" aria-label="生成阅读笔记" onClick={() => {
    if (!sessionId) { setError('无法识别当前会话'); return }
    const prompt = buildNotesPrompt()
    const request: DraftRequest = { selection: { sessionId, fileName: '', page: 1, text: prompt }, action: 'ask', text: prompt }
    const result = retryDraftInsertion(request, bindings.get(sessionId))
    setError(result.status === 'inserted' ? '' : '暂时无法插入草稿，请确认输入框可用后重试。')
  }}><ReaderIcon name="notes"/></button>{error && <span role="status">{error}</span>}</span>
}

function OpenLocalButton({ sessionId, sidebar }: { sessionId?: string; sidebar: any }) {
  const [error, setError] = useState('')
  return <span className="pr-open-local" onPointerDownCapture={event => { event.currentTarget.dataset.inputMethod = 'pointer' }} onKeyDownCapture={event => { event.currentTarget.dataset.inputMethod = 'keyboard' }}><button type="button" title="打开本地论文" aria-label="打开本地论文" onClick={() => {
    try {
      if (!sessionId || sidebar.mounted.getSnapshot() !== sessionId) { setError('当前会话的侧栏尚未就绪'); return }
      sidebar.openTab(LOCAL_TAB_KIND)
      setError('')
    } catch { setError('无法打开论文侧栏') }
  }}><ReaderIcon name="document"/></button>{error && <span role="status">{error}</span>}</span>
}

export const inject = ['slots']
export function apply(ctx: any) {
  ctx.effect(() => {
    const style = document.createElement('style'); style.dataset.dshPaperReader = ''; style.textContent = css; document.head.appendChild(style)
    workerURL = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }))
    installTrace()
    return () => { closeAllPdfDocuments(); disposePdfWorker(); uninstallTrace(); style.remove(); URL.revokeObjectURL(workerURL); workerURL = ''; bindings.clear() }
  })
  ctx.effect(() => {
    const seat = ctx.inject(['inputTriggers'], (injected: Map<string, any>) => {
      const triggers = injected.get('inputTriggers')
      if (!triggers) return
      return triggers.registerSource({
        trigger: '@', name: 'paper-reader-quote', candidates: async () => [],
        codec: { clipboardText: (ref: string) => ref, serialize: async (ref: string) => serializeInlineQuote(ref) },
      })
    })
    return () => seat.dispose()
  })
  // Each host service has its own lifecycle. One late registry must not leave
  // the whole reader waiting for activation without any visible UI.
  ctx.effect(() => {
    const seat = ctx.inject(['documentPreviews'], (injected: Map<string, any>) => {
      const previews = injected.get('documentPreviews')
      if (!previews) return
      const disposeType = previews.register({ id: READER_ID, extensions: ['pdf'], binaryExtensions: ['pdf'], priority: 'extension', title: () => '论文阅读', loading: 'bytes-complete', wrap: false })
      try {
        const disposeSlot = ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({ name: 'sidebar.right.tab.document', key: READER_ID }, DocumentBody))
        return () => { disposeSlot(); disposeType() }
      } catch (error) { disposeType(); throw error }
    })
    return () => seat.dispose()
  })
  ctx.effect(() => {
    const seat = ctx.inject(['sidebarRightTabs'], (injected: Map<string, any>) => {
      const tabs = injected.get('sidebarRightTabs')
      if (!tabs) return
      const disposeType = tabs.register({ id: LOCAL_TAB_ID, kind: LOCAL_TAB_KIND, keepMounted: true, title: () => '论文阅读' })
      try {
        const disposeSlot = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: LOCAL_TAB_ID, inject: (sessionId: string) => ({ sessionId }) }, LocalFileBody))
        return () => { disposeSlot(); disposeType() }
      } catch (error) { disposeType(); throw error }
    })
    return () => seat.dispose()
  })
  ctx.effect(() => {
    const seat = ctx.inject(['conversation', 'sessions'], (injected: Map<string, any>) => {
      const conversation = injected.get('conversation')
      const sessions = injected.get('sessions')
      if (!conversation || !sessions) return
      return ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left', id: 'dsh-paper-reader:input',
        inject: (sessionId: string) => ({
          sessionId,
          createDrafts: (files: File[]) => conversation.createDrafts(sessionId, files),
          releaseDraftAttachment: (id: string) => conversation.releaseDraftAttachment(id),
          ...(typeof conversation.sendSession === 'function' && typeof sessions.binding === 'function' ? {
            sendMessage: async (text: string, attachmentIds: string[], signal?: AbortSignal) => {
              const owner = sessions.binding(sessionId)
              if (!owner?.session || owner.session.sessionId !== sessionId) throw new Error('Reading session is no longer available')
              return conversation.sendSession(owner.session, text, attachmentIds, 'queue', signal)
            },
          } : {}),
          insertReference: (reference: DraftQuoteReference, span: InsertionSpan) => {
            const scope = sessions.scope(sessionId)
            return scope?.bail(scope, 'slash/input-insert-reference', { reference, span }) === true
          },
        }),
      }, InputBridge))
    })
    return () => seat.dispose()
  })
  ctx.effect(() => {
    return ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'dsh-paper-reader:notes', inject: (sessionId: string) => ({ sessionId }) }, NotesButton))
  })
  ctx.effect(() => {
    const seat = ctx.inject(['sidebarRight'], (injected: Map<string, any>) => {
      const sidebar = injected.get('sidebarRight')
      if (!sidebar) return
      return ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'dsh-paper-reader:open', inject: (sessionId: string) => ({ sessionId, sidebar }) }, OpenLocalButton))
    })
    return () => seat.dispose()
  })
}
