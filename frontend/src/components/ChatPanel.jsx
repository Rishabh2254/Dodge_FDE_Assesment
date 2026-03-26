import React, { useState, useRef, useEffect } from 'react'

const EXAMPLE_QUERIES = [
  "Which products are associated with the highest number of billing documents?",
  "Trace the full flow of billing document 90504274",
  "Show sales orders that have been delivered but not billed",
  "Which customers have the most sales orders?",
  "What is the total revenue by customer?",
  "List all payments with their clearing dates",
]

const NODE_COLORS = {
  SalesOrder:     '#3b82f6',
  SalesOrderItem: '#60a5fa',
  Delivery:       '#14b8a6',
  BillingDocument:'#f59e0b',
  JournalEntry:   '#f97316',
  Payment:        '#22c55e',
  Customer:       '#a855f7',
  Product:        '#ec4899',
  Plant:          '#94a3b8',
}

// ── Type detection ─────────────────────────────────────────────────────────
const TYPE_SIGNALS = {
  BillingDocument: ['billingDocument', 'billingDocumentType', 'billingDocumentIsCancelled', 'billingDocumentDate', 'cancelledBillingDocument'],
  Delivery:        ['deliveryDocument', 'overallGoodsMovementStatus', 'overallPickingStatus', 'hdrGeneralIncompletionStatus', 'shippingPoint'],
  SalesOrderItem:  ['salesOrderItem', 'salesOrderItemCategory', 'requestedQuantity', 'requestedQuantityUnit', 'materialGroup', 'itemBillingBlockReason'],
  SalesOrder:      ['salesOrder', 'soldToParty', 'overallDeliveryStatus', 'overallOrdReltdBillgStatus', 'totalNetAmount', 'pricingDate'],
  JournalEntry:    ['referenceDocument', 'accountingDocumentType', 'accountingDocumentItem', 'glAccount', 'financialAccountType'],
  Payment:         ['clearingAccountingDocument', 'clearingDocFiscalYear', 'invoiceReference', 'salesDocument'],
  Customer:        ['businessPartnerName', 'businessPartnerCategory', 'businessPartnerFullName', 'customerName'],
  Product:         ['productDescription', 'product'],
  Plant:           ['plantName', 'factoryCalendar', 'valuationArea'],
}

function detectEntityType(row) {
  const keys = new Set(Object.keys(row))
  let best = 'Record', bestScore = 0
  for (const [type, signals] of Object.entries(TYPE_SIGNALS)) {
    const score = signals.filter(s => keys.has(s)).length
    if (score > bestScore) { bestScore = score; best = type }
  }
  return bestScore >= 1 ? best : 'Record'
}

function getPrimaryId(row, type) {
  const priorityKeys = {
    BillingDocument: ['billingDocument'],
    Delivery:        ['deliveryDocument'],
    SalesOrder:      ['salesOrder'],
    SalesOrderItem:  ['salesOrder'],
    JournalEntry:    ['accountingDocument', 'journalEntry', 'journalEntryDoc'],
    Payment:         ['accountingDocument', 'paymentDoc'],
    Customer:        ['customer', 'soldToParty'],
    Product:         ['product', 'material'],
    Plant:           ['plant', 'plantCode', 'shippingPoint'],
    Record:          [],
  }
  for (const key of (priorityKeys[type] || [])) {
    const v = row[key]
    if (v && v !== 'None' && v !== 'null' && v !== '') return String(v)
  }
  return Object.values(row).find(v => v && v !== 'None' && v !== 'null' && v !== '') || null
}

function prettyKey(key) {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim()
}

function prettyVal(key, val) {
  if (val === null || val === undefined || val === 'null' || val === 'None' || val === '') return '—'
  const s = String(val)
  if (s.match(/^\d{4}-\d{2}-\d{2}T/)) return s.slice(0, 10)
  const lk = key.toLowerCase()
  if (lk.includes('amount') || lk.includes('netamount') || lk.includes('totalnet')) {
    const n = parseFloat(s)
    if (!isNaN(n)) return `₹ ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }
  if (s === 'True') return 'Yes'
  if (s === 'False') return 'No'
  return s
}

const PRIORITY_COLS = {
  BillingDocument: ['billingDocument', 'billingDocumentType', 'totalNetAmount', 'billingDocumentIsCancelled', 'soldToParty', 'creationDate'],
  Delivery:        ['deliveryDocument', 'overallGoodsMovementStatus', 'overallPickingStatus', 'shippingPoint', 'creationDate'],
  SalesOrder:      ['salesOrder', 'soldToParty', 'totalNetAmount', 'overallDeliveryStatus', 'overallOrdReltdBillgStatus', 'creationDate'],
  SalesOrderItem:  ['salesOrder', 'salesOrderItem', 'material', 'requestedQuantity', 'netAmount'],
  JournalEntry:    ['accountingDocument', 'referenceDocument', 'accountingDocumentType', 'postingDate', 'amountInTransactionCurrency', 'customer', 'glAccount', 'clearingDate', 'clearingAccountingDocument', 'journalEntryDoc', 'journalAmount', 'clearedByDoc'],
  Payment:         ['accountingDocument', 'paymentDoc', 'customer', 'amountInTransactionCurrency', 'paymentAmount', 'clearingDate', 'postingDate'],
  Customer:        ['customer', 'businessPartnerName', 'customerName', 'businessPartnerCategory', 'creationDate'],
  Product:         ['product', 'material', 'productDescription', 'billing_count', 'total_amount'],
  Plant:           ['plant', 'plantName', 'salesOrganization'],
  Record:          [],
}

// ── Export to Markdown ─────────────────────────────────────────────────────
function exportToMarkdown(session) {
  const lines = []
  lines.push(`# O2C Chat Export — ${session.title}`)
  lines.push(`*Exported on ${new Date().toLocaleString('en-IN')}*`)
  lines.push('')

  const userMessages = session.messages.filter(m => m.role === 'user')
  lines.push(`**Total queries:** ${userMessages.length}`)
  lines.push('')
  lines.push('---')
  lines.push('')

  session.messages.forEach((msg, i) => {
    if (msg.role === 'user') {
      lines.push(`## 🧑 Query ${Math.ceil(i / 2)}`)
      lines.push('')
      lines.push(`> ${msg.content}`)
      lines.push('')
    } else if (msg.role === 'assistant') {
      if (i === 0) return // skip welcome message
      lines.push(`### Answer`)
      lines.push('')
      lines.push(msg.content)
      lines.push('')

      if (msg.sql) {
        lines.push('**Generated SQL:**')
        lines.push('```sql')
        lines.push(msg.sql)
        lines.push('```')
        lines.push('')
      }

      if (msg.results && msg.results.length > 0) {
        lines.push(`**Results (${msg.results.length} records):**`)
        lines.push('')
        // Markdown table
        const cols = Object.keys(msg.results[0])
        lines.push('| ' + cols.join(' | ') + ' |')
        lines.push('| ' + cols.map(() => '---').join(' | ') + ' |')
        msg.results.slice(0, 20).forEach(row => {
          const vals = cols.map(c => String(row[c] ?? '—').replace(/\|/g, '\\|'))
          lines.push('| ' + vals.join(' | ') + ' |')
        })
        if (msg.results.length > 20) lines.push(`*...and ${msg.results.length - 20} more records*`)
        lines.push('')
      }

      lines.push('---')
      lines.push('')
    }
  })

  return lines.join('\n')
}

function downloadMarkdown(session) {
  const md = exportToMarkdown(session)
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `o2c-chat-${session.title.slice(0, 30).replace(/[^a-z0-9]/gi, '-').toLowerCase()}-${Date.now()}.md`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ── Entity Card ─────────────────────────────────────────────────────────────
function EntityCard({ row, index, onLocate }) {
  const [expanded, setExpanded] = useState(index < 5)
  const type = detectEntityType(row)
  const color = NODE_COLORS[type] || '#64748b'
  const primaryId = getPrimaryId(row, type)

  const priorityCols = PRIORITY_COLS[type] || []
  const allEntries = Object.entries(row)
  const priorityEntries = priorityCols.filter(k => row.hasOwnProperty(k)).map(k => [k, row[k]])
  const restEntries = allEntries.filter(([k]) => !priorityCols.includes(k))
  const sortedEntries = [...priorityEntries, ...restEntries]
  const topEntries = sortedEntries.slice(0, 5)
  const moreEntries = sortedEntries.slice(5)

  return (
    <div style={{ background: '#0f1520', border: `1px solid ${color}33`, borderLeft: `3px solid ${color}`, borderRadius: 10, marginBottom: 8, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: `${color}18`, borderBottom: expanded ? `1px solid ${color}22` : 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: color, boxShadow: `0 0 6px ${color}88` }} />
          <span style={{ fontSize: 11, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: '0.05em', flexShrink: 0 }}>{type} {index + 1}</span>
          {primaryId && <span style={{ fontSize: 10, color: '#475569', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>#{primaryId}</span>}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0, marginLeft: 8 }}>
          {primaryId && onLocate && (
            <button onClick={() => onLocate(primaryId)} style={{ background: `${color}22`, border: `1px solid ${color}55`, borderRadius: 6, padding: '3px 9px', fontSize: 10, color, cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap', transition: 'background 0.15s' }}
              onMouseEnter={e => e.currentTarget.style.background = `${color}44`}
              onMouseLeave={e => e.currentTarget.style.background = `${color}22`}
            >⊕ Locate</button>
          )}
          <button onClick={() => setExpanded(e => !e)} style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: 16, padding: '0 2px', lineHeight: 1, fontWeight: 300 }}>{expanded ? '−' : '+'}</button>
        </div>
      </div>
      {expanded && (
        <div style={{ padding: '10px 14px' }}>
          {topEntries.map(([k, v]) => <FieldRow key={k} label={prettyKey(k)} value={prettyVal(k, v)} />)}
          {moreEntries.length > 0 && (
            <details>
              <summary style={{ fontSize: 10, color: '#475569', cursor: 'pointer', userSelect: 'none', padding: '4px 0', marginTop: 2 }}>+ {moreEntries.length} more fields</summary>
              <div style={{ marginTop: 6 }}>
                {moreEntries.map(([k, v]) => <FieldRow key={k} label={prettyKey(k)} value={prettyVal(k, v)} />)}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  )
}

function FieldRow({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, padding: '4px 0', borderBottom: '1px solid #1e293b' }}>
      <span style={{ fontSize: 11, color: '#64748b', flexShrink: 0, minWidth: 110 }}>{label}</span>
      <span style={{ fontSize: 11, color: '#cbd5e1', textAlign: 'right', wordBreak: 'break-word', maxWidth: 190 }}>{value}</span>
    </div>
  )
}

// ── Follow-up suggestion chips ─────────────────────────────────────────────
function FollowupChips({ suggestions, onSend }) {
  if (!suggestions || suggestions.length === 0) return null
  return (
    <div style={{ marginTop: 10, marginBottom: 4 }}>
      <div style={{ fontSize: 10, color: '#475569', marginBottom: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Suggested follow-ups
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {suggestions.map((q, i) => (
          <button
            key={i}
            onClick={() => onSend(q)}
            style={{
              background: 'rgba(59,130,246,0.08)',
              border: '1px solid rgba(59,130,246,0.25)',
              borderRadius: 8,
              padding: '7px 12px',
              textAlign: 'left',
              fontSize: 11,
              color: '#93c5fd',
              cursor: 'pointer',
              transition: 'all 0.15s',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(59,130,246,0.18)'; e.currentTarget.style.borderColor = 'rgba(59,130,246,0.5)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(59,130,246,0.08)'; e.currentTarget.style.borderColor = 'rgba(59,130,246,0.25)' }}
          >
            <span style={{ fontSize: 10, opacity: 0.6, flexShrink: 0 }}>↗</span>
            {q}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Message bubble ──────────────────────────────────────────────────────────
function Message({ msg, onLocate, onSend, isLast }) {
  const isUser = msg.role === 'user'
  const [showTable, setShowTable] = useState(false)
  const hasResults = msg.results && msg.results.length > 0

  return (
    <div style={{ display: 'flex', flexDirection: isUser ? 'row-reverse' : 'row', gap: 8, marginBottom: 18, alignItems: 'flex-start' }}>
      <div style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0, background: isUser ? '#3b82f6' : '#1e293b', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#fff', fontWeight: 600 }}>
        {isUser ? 'U' : '⬡'}
      </div>
      <div style={{ maxWidth: '92%', width: '100%' }}>
        {msg.blocked && (
          <div style={{ background: '#fef3c711', border: '1px solid #f59e0b44', borderRadius: 8, padding: '6px 10px', marginBottom: 6, fontSize: 11, color: '#f59e0b' }}>
            ⚠️ Off-topic query blocked
          </div>
        )}
        <div style={{ background: isUser ? '#1d4ed8' : '#161b2e', border: `1px solid ${isUser ? '#2563eb' : '#1e293b'}`, borderRadius: isUser ? '12px 12px 4px 12px' : '12px 12px 12px 4px', padding: '10px 14px', fontSize: 13, color: '#e2e8f0', lineHeight: 1.65, marginBottom: hasResults ? 10 : 0 }}>
          {msg.content}
        </div>

        {hasResults && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: '#475569' }}>{msg.results.length} record{msg.results.length !== 1 ? 's' : ''}</span>
              <button onClick={() => setShowTable(t => !t)} style={{ background: 'none', border: '1px solid #1e293b', borderRadius: 6, padding: '3px 8px', fontSize: 10, color: '#475569', cursor: 'pointer' }}>
                {showTable ? 'Hide table' : 'Raw table'}
              </button>
            </div>
            {msg.results.map((row, i) => <EntityCard key={i} row={row} index={i} onLocate={onLocate} />)}
            {showTable && (
              <div style={{ overflowX: 'auto', marginTop: 6, marginBottom: 6 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10, background: '#0d1117', borderRadius: 8, border: '1px solid #1e293b' }}>
                  <thead><tr style={{ background: '#161b2e' }}>
                    {Object.keys(msg.results[0]).map(col => (
                      <th key={col} style={{ padding: '5px 8px', color: '#64748b', fontWeight: 600, textAlign: 'left', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid #1e293b', whiteSpace: 'nowrap' }}>{col}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {msg.results.map((row, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #0f1117' }}>
                        {Object.values(row).map((val, j) => (
                          <td key={j} style={{ padding: '5px 8px', color: '#94a3b8', fontSize: 10, whiteSpace: 'nowrap', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis' }}>{val === null || val === undefined ? '—' : String(val)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {msg.sql && (
              <details style={{ marginTop: 6 }}>
                <summary style={{ fontSize: 10, color: '#475569', cursor: 'pointer', userSelect: 'none' }}>View generated SQL</summary>
                <pre style={{ background: '#0d1117', border: '1px solid #1e293b', borderRadius: 6, padding: '8px 10px', fontSize: 10, color: '#7dd3fc', overflowX: 'auto', marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg.sql}</pre>
              </details>
            )}
          </div>
        )}
        {!hasResults && msg.sql && (
          <details style={{ marginTop: 6 }}>
            <summary style={{ fontSize: 10, color: '#475569', cursor: 'pointer', userSelect: 'none' }}>View generated SQL</summary>
            <pre style={{ background: '#0d1117', border: '1px solid #1e293b', borderRadius: 6, padding: '8px 10px', fontSize: 10, color: '#7dd3fc', overflowX: 'auto', marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg.sql}</pre>
          </details>
        )}

        {/* Follow-up chips — only on the last assistant message */}
        {!isUser && isLast && msg.followups && (
          <FollowupChips suggestions={msg.followups} onSend={onSend} />
        )}
      </div>
    </div>
  )
}

// ── Main ChatPanel ──────────────────────────────────────────────────────────
const MEMORY_WINDOW = 6

export default function ChatPanel({ apiBase, graphData, onHighlight, onZoomToNode, session, onMessagesUpdate }) {
  const messages = session?.messages || []
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [exported, setExported] = useState(false)
  const bottomRef = useRef()

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, loading])

  const setMessages = (updater) => {
    const next = typeof updater === 'function' ? updater(messages) : updater
    onMessagesUpdate(session.id, next)
  }

  const handleExport = () => {
    downloadMarkdown(session)
    setExported(true)
    setTimeout(() => setExported(false), 2000)
  }

  const send = async (question) => {
    if (!question.trim() || loading) return
    const q = question.trim()
    setInput('')
    const newMessages = [...messages, { role: 'user', content: q }]
    setMessages(newMessages)
    setLoading(true)

    const history = newMessages
      .filter(m => !(m.role === 'assistant' && !m.sql && !m.results && newMessages.indexOf(m) === 0))
      .slice(-MEMORY_WINDOW)
      .map(m => ({ role: m.role, content: m.content }))

    try {
      const res = await fetch(`${apiBase}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, conversation_history: history }),
      })
      const data = await res.json()

      setMessages([...newMessages, {
        role: 'assistant',
        content: data.answer,
        sql: data.sql,
        results: data.results,
        blocked: data.blocked,
        followups: data.followups || [],
      }])

      if (data.results?.length > 0 && onHighlight) {
        const ids = []
        data.results.forEach(row => {
          Object.values(row).forEach(v => {
            if (v && typeof v === 'string' && v.length > 3) {
              ids.push(`SO:${v}`, `BILL:${v}`, `DEL:${v}`, `JE:${v}`, `PAY:${v}`, `CUST:${v}`, `PROD:${v}`, `PLANT:${v}`)
            }
          })
        })
        onHighlight(ids)
      }
    } catch {
      setMessages([...newMessages, {
        role: 'assistant',
        content: 'Something went wrong connecting to the backend. Please try again.',
        sql: null, results: null, followups: [],
      }])
    } finally {
      setLoading(false)
    }
  }

  const userCount = messages.filter(m => m.role === 'user').length
  const lastAssistantIndex = messages.map((m, i) => m.role === 'assistant' ? i : -1).filter(i => i >= 0).pop()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '10px 14px', background: '#161b2e', borderBottom: '1px solid #1e293b', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#f1f5f9' }}>Query Assistant</div>
          <div style={{ fontSize: 11, color: '#475569' }}>
            Natural language → SQL → grounded answers
            {userCount > 0 && <span style={{ marginLeft: 8, color: '#334155' }}>· {userCount} quer{userCount === 1 ? 'y' : 'ies'}</span>}
          </div>
        </div>

        {/* Export button — only if there are actual queries */}
        {userCount > 0 && (
          <button
            onClick={handleExport}
            title="Export chat as Markdown"
            style={{
              background: exported ? '#14532d' : '#1e293b',
              border: `1px solid ${exported ? '#16a34a' : '#334155'}`,
              borderRadius: 8,
              padding: '5px 10px',
              fontSize: 11,
              color: exported ? '#4ade80' : '#94a3b8',
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 5,
              transition: 'all 0.2s',
              flexShrink: 0,
            }}
            onMouseEnter={e => { if (!exported) { e.currentTarget.style.background = '#334155'; e.currentTarget.style.color = '#e2e8f0' } }}
            onMouseLeave={e => { if (!exported) { e.currentTarget.style.background = '#1e293b'; e.currentTarget.style.color = '#94a3b8' } }}
          >
            {exported ? '✓ Exported' : '↓ Export .md'}
          </button>
        )}
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflow: 'auto', padding: '14px 14px 0' }}>
        {messages.map((msg, i) => (
          <Message
            key={i}
            msg={msg}
            onLocate={onZoomToNode}
            onSend={send}
            isLast={i === lastAssistantIndex && !loading}
          />
        ))}
        {loading && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
            <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#1e293b', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#fff' }}>⬡</div>
            <div style={{ background: '#161b2e', border: '1px solid #1e293b', borderRadius: '12px 12px 12px 4px', padding: '10px 16px', display: 'flex', gap: 4, alignItems: 'center' }}>
              {[0, 1, 2].map(i => (
                <div key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: '#3b82f6', animation: `chatpulse 1.2s ease-in-out ${i * 0.2}s infinite` }} />
              ))}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Example queries */}
      {userCount === 0 && (
        <div style={{ padding: '0 14px 10px', flexShrink: 0 }}>
          <div style={{ fontSize: 10, color: '#475569', marginBottom: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Try these queries</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {EXAMPLE_QUERIES.map((q, i) => (
              <button key={i} onClick={() => send(q)} style={{ background: '#161b2e', border: '1px solid #1e293b', borderRadius: 8, padding: '7px 10px', textAlign: 'left', fontSize: 11, color: '#94a3b8', cursor: 'pointer', transition: 'all 0.1s' }}
                onMouseEnter={e => { e.target.style.background = '#1e293b'; e.target.style.color = '#e2e8f0' }}
                onMouseLeave={e => { e.target.style.background = '#161b2e'; e.target.style.color = '#94a3b8' }}
              >{q}</button>
            ))}
          </div>
        </div>
      )}

      {/* Input */}
      <div style={{ padding: '10px 14px', borderTop: '1px solid #1e293b', flexShrink: 0, display: 'flex', gap: 8, background: '#0f1117' }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send(input)}
          placeholder="Ask about orders, deliveries, billing..."
          disabled={loading}
          style={{ flex: 1, background: '#161b2e', border: '1px solid #1e293b', borderRadius: 10, padding: '9px 14px', color: '#e2e8f0', fontSize: 13, outline: 'none' }}
          onFocus={e => e.target.style.borderColor = '#3b82f6'}
          onBlur={e => e.target.style.borderColor = '#1e293b'}
        />
        <button onClick={() => send(input)} disabled={loading || !input.trim()} style={{ background: loading || !input.trim() ? '#1e293b' : '#3b82f6', border: 'none', borderRadius: 10, padding: '9px 16px', color: '#fff', fontSize: 13, fontWeight: 600, cursor: loading || !input.trim() ? 'not-allowed' : 'pointer', transition: 'background 0.15s' }}>
          {loading ? '...' : '→'}
        </button>
      </div>

      <style>{`
        @keyframes chatpulse {
          0%, 100% { opacity: 0.3; transform: scale(0.8); }
          50% { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  )
}
