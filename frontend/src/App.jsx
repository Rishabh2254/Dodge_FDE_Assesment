import React, { useState, useEffect, useRef, useCallback } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import NodePanel from './components/NodePanel.jsx'
import ChatPanel from './components/ChatPanel.jsx'
import StatsBar from './components/StatsBar.jsx'

const API = import.meta.env.VITE_API_URL || '/api'

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

const NODE_SIZES = {
  SalesOrder:     8,
  Customer:       10,
  BillingDocument:7,
  Payment:        7,
  JournalEntry:   6,
  Delivery:       7,
  SalesOrderItem: 5,
  Product:        6,
  Plant:          8,
}

// Flow chain colors per node type for the O2C path highlight
const FLOW_COLORS = {
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

const TOOLTIP_PROPS = {
  SalesOrder:      ['salesOrder', 'totalNetAmount', 'transactionCurrency', 'overallDeliveryStatus', 'creationDate'],
  SalesOrderItem:  ['salesOrderItem', 'material', 'requestedQuantity', 'netAmount'],
  Delivery:        ['deliveryDocument', 'overallGoodsMovementStatus', 'overallPickingStatus', 'creationDate'],
  BillingDocument: ['billingDocument', 'totalNetAmount', 'billingDocumentIsCancelled', 'billingDocumentType', 'creationDate'],
  JournalEntry:    ['accountingDocument', 'postingDate', 'amountInTransactionCurrency', 'accountingDocumentType', 'referenceDocument'],
  Payment:         ['accountingDocument', 'amountInTransactionCurrency', 'clearingDate', 'customer'],
  Customer:        ['customer', 'businessPartnerName', 'businessPartnerCategory'],
  Product:         ['product', 'productDescription'],
  Plant:           ['plant', 'plantName', 'salesOrganization'],
}

const STATUS_LABELS = {
  overallDeliveryStatus:      { C: 'Fully delivered', A: 'Not delivered', B: 'Partial', '': 'None' },
  overallGoodsMovementStatus: { C: 'Complete', A: 'Not moved', B: 'Partial', '': 'Pending' },
  overallPickingStatus:       { C: 'Complete', A: 'Not started', B: 'Partial', '': 'Pending' },
  billingDocumentIsCancelled: { 'True': 'Cancelled', 'False': 'Active' },
}

function formatPropValue(key, val) {
  if (!val || val === 'null' || val === '{}') return null
  if (STATUS_LABELS[key] && STATUS_LABELS[key][val] !== undefined) return STATUS_LABELS[key][val]
  if (typeof val === 'string' && val.match(/^\d{4}-\d{2}-\d{2}T/)) return val.slice(0, 10)
  return val
}

// ── Session storage helpers ────────────────────────────────────────────────
const STORAGE_KEY = 'o2c_chat_sessions'
const ACTIVE_KEY  = 'o2c_active_session'

function loadSessions() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') } catch { return [] }
}
function saveSessions(sessions) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions))
}
function makeSessionId() {
  return 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)
}
function makeNewSession() {
  return {
    id: makeSessionId(),
    title: 'New chat',
    createdAt: Date.now(),
    messages: [{
      role: 'assistant',
      content: 'Ask me anything about the Order-to-Cash dataset. I can trace document flows, analyze billing, find payment patterns, and more.',
      sql: null,
      results: null,
    }],
  }
}

// ── Main component ─────────────────────────────────────────────────────────
export default function App() {
  // Graph data
  const [graphData, setGraphData]         = useState({ nodes: [], links: [] })
  const [stats, setStats]                 = useState(null)
  const [loading, setLoading]             = useState(true)

  // Node interaction
  const [selectedNode, setSelectedNode]   = useState(null)
  const [highlightNodes, setHighlightNodes] = useState(new Set())
  const [highlightLinks, setHighlightLinks] = useState(new Set())
  const [hoveredNode, setHoveredNode]     = useState(null)
  const [tooltipPos, setTooltipPos]       = useState({ x: 0, y: 0 })

  // Graph display
  const [filterType, setFilterType]       = useState('all')
  const [chatHighlight, setChatHighlight] = useState(new Set())
  const [flowHighlight, setFlowHighlight] = useState({}) // nodeId -> color

  // Session management
  const [sessions, setSessions]           = useState(() => {
    const s = loadSessions()
    return s.length > 0 ? s : [makeNewSession()]
  })
  const [activeSessionId, setActiveSessionId] = useState(() => {
    const saved = localStorage.getItem(ACTIVE_KEY)
    const s = loadSessions()
    if (saved && s.find(x => x.id === saved)) return saved
    return s.length > 0 ? s[0].id : makeNewSession().id
  })
  const [sidebarOpen, setSidebarOpen]     = useState(true)
  const [menuOpenId, setMenuOpenId]       = useState(null)
  const [renamingId, setRenamingId]       = useState(null)
  const [renameValue, setRenameValue]     = useState('')

  const fgRef        = useRef()
  const containerRef = useRef()

  // Persist sessions
  useEffect(() => { saveSessions(sessions) }, [sessions])
  useEffect(() => { localStorage.setItem(ACTIVE_KEY, activeSessionId) }, [activeSessionId])

  // Load graph
  useEffect(() => {
    Promise.all([
      fetch(API + '/graph').then(r => r.json()),
      fetch(API + '/stats').then(r => r.json()),
    ]).then(([graph, statsData]) => {
      const links = graph.edges.map(e => ({ source: e.source, target: e.target, relation: e.relation }))
      setGraphData({ nodes: graph.nodes, links })
      setStats(statsData)
      setLoading(false)
    })
  }, [])

  // ── Session helpers ────────────────────────────────────────────────────
  const activeSession = sessions.find(s => s.id === activeSessionId) || sessions[0]

  const handleNewChat = useCallback(() => {
    const s = makeNewSession()
    setSessions(prev => [s, ...prev])
    setActiveSessionId(s.id)
    setSelectedNode(null)
    setHighlightNodes(new Set())
    setHighlightLinks(new Set())
    setMenuOpenId(null)
  }, [])

  const handleSelectSession = useCallback((id) => {
    setActiveSessionId(id)
    setSelectedNode(null)
    setHighlightNodes(new Set())
    setHighlightLinks(new Set())
    setMenuOpenId(null)
  }, [])

  const handleDeleteSession = useCallback((id) => {
    setMenuOpenId(null)
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id)
      if (next.length === 0) {
        const fresh = makeNewSession()
        setActiveSessionId(fresh.id)
        return [fresh]
      }
      if (id === activeSessionId) setActiveSessionId(next[0].id)
      return next
    })
  }, [activeSessionId])

  const handleStartRename = useCallback((id, currentTitle, e) => {
    e.stopPropagation()
    setMenuOpenId(null)
    setRenamingId(id)
    setRenameValue(currentTitle)
  }, [])

  const handleConfirmRename = useCallback((id) => {
    if (renameValue.trim()) {
      setSessions(prev => prev.map(s => s.id === id ? { ...s, title: renameValue.trim() } : s))
    }
    setRenamingId(null)
    setRenameValue('')
  }, [renameValue])

  const handleMessagesUpdate = useCallback((sessionId, messages) => {
    setSessions(prev => prev.map(s => {
      if (s.id !== sessionId) return s
      const firstUser = messages.find(m => m.role === 'user')
      const title = firstUser
        ? firstUser.content.slice(0, 42) + (firstUser.content.length > 42 ? '…' : '')
        : s.title
      return { ...s, messages, title }
    }))
  }, [])

  // ── Flow path trace — defined BEFORE handleNodeClick ──────────────────
  // BFS through graph edges to find the full connected O2C chain
  const traceFlowChain = useCallback((node) => {
    if (!node) { setFlowHighlight({}); return }
    const colors = {}
    const visited = new Set()
    const edgeMap = {}
    graphData.links.forEach(link => {
      const src = link.source?.id || link.source
      const tgt = link.target?.id || link.target
      if (!edgeMap[src]) edgeMap[src] = []
      if (!edgeMap[tgt]) edgeMap[tgt] = []
      edgeMap[src].push(tgt)
      edgeMap[tgt].push(src)
    })
    const queue = [node.id]
    while (queue.length > 0) {
      const current = queue.shift()
      if (visited.has(current)) continue
      visited.add(current)
      const nodeObj = graphData.nodes.find(n => n.id === current)
      if (nodeObj) colors[current] = FLOW_COLORS[nodeObj.type] || '#888'
      const neighbors = edgeMap[current] || []
      neighbors.forEach(id => { if (!visited.has(id)) queue.push(id) })
    }
    setFlowHighlight(colors)
    setTimeout(() => setFlowHighlight({}), 8000)
  }, [graphData])

  // ── Graph interaction — defined AFTER traceFlowChain ──────────────────
  const handleNodeClick = useCallback((node) => {
    setSelectedNode(node)
    setHoveredNode(null)
    const neighbors = new Set()
    const links = new Set()
    graphData.links.forEach(link => {
      const srcId = link.source?.id || link.source
      const tgtId = link.target?.id || link.target
      if (srcId === node.id) { neighbors.add(tgtId); links.add(link) }
      if (tgtId === node.id) { neighbors.add(srcId); links.add(link) }
    })
    neighbors.add(node.id)
    setHighlightNodes(neighbors)
    setHighlightLinks(links)
    traceFlowChain(node)
  }, [graphData, traceFlowChain])

  const handleBackgroundClick = useCallback(() => {
    setSelectedNode(null)
    setHoveredNode(null)
    setHighlightNodes(new Set())
    setHighlightLinks(new Set())
    setFlowHighlight({})
  }, [])

  const handleNodeHover = useCallback((node) => {
    setHoveredNode(node || null)
    if (containerRef.current) containerRef.current.style.cursor = node ? 'pointer' : 'default'
  }, [])

  const handleMouseMove = useCallback((e) => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    setTooltipPos({ x: e.clientX - rect.left, y: e.clientY - rect.top })
  }, [])

  const handleChatHighlight = useCallback((nodeIds) => {
    setChatHighlight(new Set(nodeIds))
    setTimeout(() => setChatHighlight(new Set()), 6000)
  }, [])

  const zoomToNode = useCallback((searchId) => {
    if (!fgRef.current || !searchId) return
    const node = graphData.nodes.find(n => {
      if (n.id.includes(String(searchId))) return true
      return Object.values(n.props || {}).some(v => v === String(searchId))
    })
    if (!node) return
    setChatHighlight(new Set([node.id]))
    setTimeout(() => setChatHighlight(new Set()), 6000)
    fgRef.current.centerAt(node.x, node.y, 800)
    fgRef.current.zoom(6, 800)
  }, [graphData])

  const filteredGraph = useCallback(() => {
    if (filterType === 'all') return graphData
    const filteredNodes = graphData.nodes.filter(n => n.type === filterType)
    const filteredIds = new Set(filteredNodes.map(n => n.id))
    const filteredLinks = graphData.links.filter(
      l => filteredIds.has(l.source?.id || l.source) && filteredIds.has(l.target?.id || l.target)
    )
    return { nodes: filteredNodes, links: filteredLinks }
  }, [graphData, filterType])

  // ── Canvas render helpers ──────────────────────────────────────────────
  const nodeColor = useCallback((node) => {
    if (chatHighlight.has(node.id)) return '#ffffff'
    if (Object.keys(flowHighlight).length > 0) {
      return flowHighlight[node.id] || '#1a2035'
    }
    if (highlightNodes.size > 0) return highlightNodes.has(node.id) ? NODE_COLORS[node.type] || '#888' : '#2a2a3a'
    return NODE_COLORS[node.type] || '#888'
  }, [highlightNodes, chatHighlight, flowHighlight])

  const linkColor = useCallback((link) => {
    const srcId = link.source?.id || link.source
    const tgtId = link.target?.id || link.target
    if (Object.keys(flowHighlight).length > 0) {
      return (flowHighlight[srcId] && flowHighlight[tgtId])
        ? 'rgba(148,163,184,0.6)'
        : 'rgba(148,163,184,0.03)'
    }
    if (highlightLinks.size === 0) return 'rgba(148,163,184,0.15)'
    return highlightLinks.has(link) ? 'rgba(148,163,184,0.7)' : 'rgba(148,163,184,0.05)'
  }, [highlightLinks, flowHighlight])

  const nodeSize = useCallback((node) => {
    const base = NODE_SIZES[node.type] || 6
    if (chatHighlight.has(node.id)) return base * 1.8
    if (hoveredNode?.id === node.id) return base * 1.5
    if (selectedNode?.id === node.id) return base * 1.6
    if (flowHighlight[node.id]) return base * 1.4
    if (highlightNodes.has(node.id)) return base * 1.3
    return base
  }, [selectedNode, highlightNodes, chatHighlight, hoveredNode, flowHighlight])

  const nodeCanvasObject = useCallback((node, ctx, globalScale) => {
    // White pulse ring for chat-highlighted nodes
    if (chatHighlight.has(node.id)) {
      const r = (NODE_SIZES[node.type] || 6) + 4
      ctx.beginPath()
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI)
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
    // Colored glow ring for flow-chain nodes
    if (flowHighlight[node.id]) {
      const color = flowHighlight[node.id]
      const r = (NODE_SIZES[node.type] || 6) + 5
      ctx.beginPath()
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI)
      ctx.strokeStyle = color + 'cc'
      ctx.lineWidth = 2
      ctx.stroke()
    }
    // Label when zoomed in
    if (globalScale >= 2) {
      const fontSize = 10 / globalScale
      ctx.font = fontSize + 'px Sans-Serif'
      ctx.fillStyle = 'rgba(241,245,249,0.85)'
      ctx.textAlign = 'center'
      ctx.fillText(node.label, node.x, node.y + (NODE_SIZES[node.type] || 6) / globalScale + fontSize + 1)
    }
  }, [chatHighlight, flowHighlight])

  // ── Tooltip render ─────────────────────────────────────────────────────
  const renderTooltip = () => {
    if (!hoveredNode) return null
    const color = NODE_COLORS[hoveredNode.type] || '#888'
    const propsToShow = TOOLTIP_PROPS[hoveredNode.type] || Object.keys(hoveredNode.props || {}).slice(0, 5)
    const entries = propsToShow
      .map(k => [k, formatPropValue(k, hoveredNode.props?.[k])])
      .filter(([, v]) => v !== null && v !== undefined)
    const W = 220
    const containerW = containerRef.current?.offsetWidth || 800
    const containerH = containerRef.current?.offsetHeight || 600
    let tx = tooltipPos.x + 14
    let ty = tooltipPos.y - 10
    if (tx + W > containerW - 10) tx = tooltipPos.x - W - 14
    if (ty + 220 > containerH) ty = containerH - 230
    return (
      <div style={{ position: 'absolute', left: tx, top: ty, width: W, background: 'rgba(15,17,23,0.97)', border: '1px solid ' + color + '55', borderRadius: 10, padding: '10px 12px', pointerEvents: 'none', zIndex: 50, boxShadow: '0 4px 24px rgba(0,0,0,0.5)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0, boxShadow: '0 0 6px ' + color }} />
          <span style={{ fontSize: 10, fontWeight: 700, color, letterSpacing: '0.05em', textTransform: 'uppercase' }}>{hoveredNode.type}</span>
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#f1f5f9', marginBottom: 8, lineHeight: 1.3 }}>{hoveredNode.label}</div>
        <div style={{ borderTop: '1px solid ' + color + '22', paddingTop: 7 }}>
          {entries.map(([k, v]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 10, color: '#64748b', flexShrink: 0 }}>{k.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).slice(0, 22)}</span>
              <span style={{ fontSize: 10, color: '#cbd5e1', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 110 }}>{v}</span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 7, fontSize: 10, color: '#475569', textAlign: 'center' }}>Click to open inspector →</div>
      </div>
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0f1117' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 20px', background: '#161b2e', borderBottom: '1px solid #1e293b', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>⬡</div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#f1f5f9' }}>O2C Graph Explorer</div>
            <div style={{ fontSize: 11, color: '#64748b' }}>Order-to-Cash · SAP Dataset</div>
          </div>
        </div>
        <StatsBar stats={stats} />
      </div>

      {/* Body */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* Graph panel */}
        <div ref={containerRef} style={{ flex: 1, position: 'relative', overflow: 'hidden' }} onMouseMove={handleMouseMove} onMouseLeave={() => setHoveredNode(null)}>

          {/* Filter bar */}
          <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {['all', ...Object.keys(NODE_COLORS)].map(type => (
              <button key={type} onClick={() => setFilterType(type)} style={{ padding: '4px 10px', borderRadius: 20, border: 'none', fontSize: 11, cursor: 'pointer', fontWeight: 500, background: filterType === type ? (NODE_COLORS[type] || '#3b82f6') : 'rgba(30,41,59,0.9)', color: filterType === type ? '#fff' : '#94a3b8', backdropFilter: 'blur(4px)', transition: 'all 0.15s' }}>
                {type === 'all' ? 'All' : type}
              </button>
            ))}
          </div>

          {/* Flow highlight legend */}
          {Object.keys(flowHighlight).length > 0 && (
            <div style={{ position: 'absolute', top: 50, left: 12, zIndex: 10, background: 'rgba(22,27,46,0.95)', borderRadius: 8, padding: '6px 12px', border: '1px solid #1e293b', fontSize: 11, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#f97316' }} />
              Flow chain highlighted · click background to clear
            </div>
          )}

          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#64748b', flexDirection: 'column', gap: 12 }}>
              <div style={{ fontSize: 32 }}>⬡</div>
              <div>Loading graph data...</div>
            </div>
          ) : (
            <ForceGraph2D
              ref={fgRef}
              graphData={filteredGraph()}
              nodeId="id"
              nodeLabel={() => ''}
              nodeColor={nodeColor}
              nodeVal={nodeSize}
              linkColor={linkColor}
              linkWidth={link => highlightLinks.has(link) ? 1.5 : 0.5}
              linkDirectionalArrowLength={3}
              linkDirectionalArrowRelPos={1}
              linkDirectionalArrowColor={linkColor}
              onNodeClick={handleNodeClick}
              onNodeHover={handleNodeHover}
              onBackgroundClick={handleBackgroundClick}
              backgroundColor="#0f1117"
              linkLabel={link => link.relation}
              d3AlphaDecay={0.02}
              d3VelocityDecay={0.3}
              cooldownTime={3000}
              nodeCanvasObjectMode={() => 'after'}
              nodeCanvasObject={nodeCanvasObject}
            />
          )}

          {hoveredNode && renderTooltip()}

          {/* Legend */}
          <div style={{ position: 'absolute', bottom: 12, left: 12, zIndex: 10, background: 'rgba(22,27,46,0.92)', borderRadius: 10, padding: '10px 14px', backdropFilter: 'blur(4px)', border: '1px solid #1e293b' }}>
            <div style={{ fontSize: 10, color: '#64748b', marginBottom: 6, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Node types</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 16px' }}>
              {Object.entries(NODE_COLORS).map(([type, color]) => (
                <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
                  <span style={{ fontSize: 10, color: '#94a3b8' }}>{type}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right side: sidebar + panel */}
        <div style={{ display: 'flex', borderLeft: '1px solid #1e293b', flexShrink: 0 }}>

          {/* Chat history sidebar */}
          {sidebarOpen && (
            <div style={{ width: 200, background: '#0d1117', borderRight: '1px solid #1e293b', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ padding: '12px 12px 8px', borderBottom: '1px solid #1e293b', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Chats</span>
                <button onClick={() => setSidebarOpen(false)} style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1 }}>‹</button>
              </div>

              <div style={{ padding: '8px 10px', borderBottom: '1px solid #1e293b' }}>
                <button onClick={handleNewChat} style={{ width: '100%', background: '#1e293b', border: '1px solid #334155', borderRadius: 8, padding: '7px 10px', color: '#94a3b8', fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, transition: 'all 0.15s' }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#334155'; e.currentTarget.style.color = '#e2e8f0' }}
                  onMouseLeave={e => { e.currentTarget.style.background = '#1e293b'; e.currentTarget.style.color = '#94a3b8' }}>
                  <span style={{ fontSize: 14, lineHeight: 1 }}>+</span> New chat
                </button>
              </div>

              <div style={{ flex: 1, overflow: 'auto' }} onClick={() => setMenuOpenId(null)}>
                {sessions.map(session => {
                  const isActive   = session.id === activeSessionId
                  const isMenuOpen = menuOpenId === session.id
                  const isRenaming = renamingId === session.id
                  return (
                    <div key={session.id} onClick={() => !isRenaming && handleSelectSession(session.id)}
                      style={{ padding: '9px 10px 9px 12px', cursor: 'pointer', background: isActive ? '#1e293b' : 'transparent', borderLeft: isActive ? '2px solid #3b82f6' : '2px solid transparent', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, transition: 'background 0.1s', position: 'relative' }}
                      onMouseEnter={e => {
                        if (!isActive) e.currentTarget.style.background = '#161b2e'
                        const btn = e.currentTarget.querySelector('.dots-btn')
                        if (btn) btn.style.opacity = '1'
                      }}
                      onMouseLeave={e => {
                        if (!isActive) e.currentTarget.style.background = 'transparent'
                        const btn = e.currentTarget.querySelector('.dots-btn')
                        if (btn && !isMenuOpen) btn.style.opacity = '0'
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        {isRenaming ? (
                          <input autoFocus value={renameValue}
                            onChange={e => setRenameValue(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') handleConfirmRename(session.id)
                              if (e.key === 'Escape') { setRenamingId(null); setRenameValue('') }
                              e.stopPropagation()
                            }}
                            onBlur={() => handleConfirmRename(session.id)}
                            onClick={e => e.stopPropagation()}
                            style={{ width: '100%', background: '#0f1117', border: '1px solid #3b82f6', borderRadius: 4, padding: '2px 6px', color: '#e2e8f0', fontSize: 11, outline: 'none' }}
                          />
                        ) : (
                          <>
                            <div style={{ fontSize: 11, color: isActive ? '#e2e8f0' : '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: isActive ? 500 : 400, lineHeight: 1.4 }}>
                              {session.title}
                            </div>
                            <div style={{ fontSize: 10, color: '#334155', marginTop: 2 }}>
                              {new Date(session.createdAt).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })}
                            </div>
                          </>
                        )}
                      </div>

                      {!isRenaming && (
                        <div style={{ position: 'relative', flexShrink: 0 }}>
                          <button className="dots-btn"
                            onClick={e => { e.stopPropagation(); setMenuOpenId(isMenuOpen ? null : session.id) }}
                            style={{ background: isMenuOpen ? '#334155' : 'none', border: 'none', borderRadius: 4, color: '#64748b', cursor: 'pointer', padding: '2px 5px', fontSize: 14, lineHeight: 1, opacity: isActive || isMenuOpen ? '1' : '0', transition: 'opacity 0.1s, background 0.1s' }}
                          >···</button>

                          {isMenuOpen && (
                            <div onClick={e => e.stopPropagation()} style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', background: '#1e293b', border: '1px solid #334155', borderRadius: 8, padding: '4px', zIndex: 100, minWidth: 140, boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
                              <button onClick={e => handleStartRename(session.id, session.title, e)}
                                style={{ width: '100%', background: 'none', border: 'none', padding: '7px 10px', color: '#cbd5e1', fontSize: 12, cursor: 'pointer', textAlign: 'left', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 8 }}
                                onMouseEnter={e => e.currentTarget.style.background = '#334155'}
                                onMouseLeave={e => e.currentTarget.style.background = 'none'}
                              >✎ Rename</button>
                              <div style={{ height: 1, background: '#334155', margin: '3px 6px' }} />
                              <button onClick={() => handleDeleteSession(session.id)}
                                style={{ width: '100%', background: 'none', border: 'none', padding: '7px 10px', color: '#f87171', fontSize: 12, cursor: 'pointer', textAlign: 'left', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 8 }}
                                onMouseEnter={e => e.currentTarget.style.background = '#450a0a'}
                                onMouseLeave={e => e.currentTarget.style.background = 'none'}
                              >🗑 Delete chat</button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Collapsed sidebar */}
          {!sidebarOpen && (
            <div style={{ width: 28, background: '#0d1117', borderRight: '1px solid #1e293b', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 10, gap: 8 }}>
              <button onClick={() => setSidebarOpen(true)} style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: 14, padding: 2 }}>›</button>
              <button onClick={handleNewChat} style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: 16, padding: 2 }} title="New chat">+</button>
            </div>
          )}

          {/* Main panel: node inspector or chat */}
          <div style={{ width: 400, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {selectedNode ? (
              <NodePanel
                node={selectedNode}
                graphData={graphData}
                onClose={() => { setSelectedNode(null); setHighlightNodes(new Set()); setHighlightLinks(new Set()); setFlowHighlight({}) }}
                onNodeSelect={handleNodeClick}
              />
            ) : (
              <ChatPanel
                key={activeSessionId}
                apiBase={API}
                graphData={graphData}
                onHighlight={handleChatHighlight}
                onZoomToNode={zoomToNode}
                session={activeSession}
                onMessagesUpdate={handleMessagesUpdate}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
