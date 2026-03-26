import React from 'react'

export default function StatsBar({ stats }) {
  if (!stats) return null
  return (
    <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
      {[
        { label: 'Nodes', value: stats.graph?.nodes },
        { label: 'Edges', value: stats.graph?.edges },
        { label: 'Orders', value: stats.tables?.sales_order_headers },
        { label: 'Billing Docs', value: stats.tables?.billing_document_cancellations },
        { label: 'Payments', value: stats.tables?.payments_accounts_receivable },
      ].map(({ label, value }) => (
        <div key={label} style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#60a5fa' }}>{value ?? '—'}</div>
          <div style={{ fontSize: 10, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
        </div>
      ))}
    </div>
  )
}
