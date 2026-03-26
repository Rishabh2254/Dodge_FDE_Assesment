import React, { useMemo } from 'react'

const TYPE_COLORS = {
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

function Badge({ type }) {
  const color = TYPE_COLORS[type] || '#64748b'
  return (
    <span style={{
      background: color + '22',
      color: color,
      border: `1px solid ${color}44`,
      borderRadius: 4,
      padding: '2px 8px',
      fontSize: 11,
      fontWeight: 600,
    }}>{type}</span>
  )
}

function PropRow({ k, v }) {
  if (!v || v === 'null' || v === '{}') return null
  return (
    <div style={{ display: 'flex', gap: 8, padding: '5px 0', borderBottom: '1px solid #1e293b' }}>
      <span style={{ color: '#64748b', fontSize: 11, minWidth: 140, flexShrink: 0 }}>{k}</span>
      <span style={{ color: '#cbd5e1', fontSize: 11, wordBreak: 'break-all' }}>{String(v)}</span>
    </div>
  )
}

export default function NodePanel({ node, graphData, onClose, onNodeSelect }) {
  const { incoming, outgoing } = useMemo(() => {
    const inc = []
    const out = []
    graphData.links.forEach(link => {
      const srcId = link.source?.id || link.source
      const tgtId = link.target?.id || link.target
      if (srcId === node.id) {
        const tgt = graphData.nodes.find(n => n.id === tgtId)
        if (tgt) out.push({ node: tgt, relation: link.relation })
      }
      if (tgtId === node.id) {
        const src = graphData.nodes.find(n => n.id === srcId)
        if (src) inc.push({ node: src, relation: link.relation })
      }
    })
    return { incoming: inc, outgoing: out }
  }, [node, graphData])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '14px 16px', background: '#161b2e', borderBottom: '1px solid #1e293b',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between'
      }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Badge type={node.type} />
          </div>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#f1f5f9' }}>{node.label}</div>
          <div style={{ fontSize: 11, color: '#475569', marginTop: 2 }}>{node.id}</div>
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'none', border: 'none', color: '#64748b',
            cursor: 'pointer', fontSize: 18, padding: 4, lineHeight: 1
          }}
        >×</button>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
        {/* Properties */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#475569', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
            Properties
          </div>
          {Object.entries(node.props || {}).map(([k, v]) => (
            <PropRow key={k} k={k} v={v} />
          ))}
        </div>

        {/* Outgoing */}
        {outgoing.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#475569', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
              Outgoing ({outgoing.length})
            </div>
            {outgoing.map(({ node: n, relation }, i) => (
              <RelationRow key={i} node={n} relation={relation} dir="→" onSelect={onNodeSelect} />
            ))}
          </div>
        )}

        {/* Incoming */}
        {incoming.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#475569', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
              Incoming ({incoming.length})
            </div>
            {incoming.map(({ node: n, relation }, i) => (
              <RelationRow key={i} node={n} relation={relation} dir="←" onSelect={onNodeSelect} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function RelationRow({ node, relation, dir, onSelect }) {
  const color = TYPE_COLORS[node.type] || '#64748b'
  return (
    <div
      onClick={() => onSelect(node)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 10px', borderRadius: 8, cursor: 'pointer',
        marginBottom: 4, background: '#161b2e',
        border: '1px solid #1e293b',
        transition: 'background 0.1s',
      }}
      onMouseEnter={e => e.currentTarget.style.background = '#1e293b'}
      onMouseLeave={e => e.currentTarget.style.background = '#161b2e'}
    >
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {node.label}
        </div>
        <div style={{ fontSize: 10, color: '#475569' }}>{dir} {relation}</div>
      </div>
      <span style={{ fontSize: 10, color: color + '99', fontWeight: 500 }}>{node.type}</span>
    </div>
  )
}
