import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase'

const money  = (n) => Math.abs(Number(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const usd    = (n) => n != null ? `${Number(n) < 0 ? '-' : ''}$${money(n)}` : '—'
const fmtPnl = (n) => { if (n == null) return '—'; return `${Number(n) >= 0 ? '+$' : '-$'}${money(n)}` }
const pct    = (n) => n == null || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`
const num    = (v) => Number(v) || 0
const pnlColor = (n) => n >= 0 ? 'var(--success)' : 'var(--danger)'

// 'YYYY-MM' keys straight from the stored strings, so a box bought on the 1st
// never slides into the previous month through a timezone conversion.
const monthKey   = (s) => s ? String(s).slice(0, 7) : null
const monthLabel = (key) => { const [y, m] = key.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) }
const todayLocal = () => new Date().toLocaleDateString('en-CA')   // YYYY-MM-DD in local time

const platformNet = (p) => p ? num(p.gross_sales) - num(p.refunds) - num(p.fees) - num(p.shipping_labels) : null

// Sellable value: only cards at/above the Boxes page's "True value" cutoff, less selling costs
const SELLABLE_MIN   = 2
const SELL_COST_PCT  = 0.14

const CATEGORIES   = ['postage', 'supplies', 'other']
const RATE_KEY     = 'profit.postageRate'
const DEFAULT_RATE = 3.10

function readRate() {
  try { const v = parseFloat(localStorage.getItem(RATE_KEY)); return v >= 0 ? v : DEFAULT_RATE } catch { return DEFAULT_RATE }
}
function writeRate(v) {
  try { localStorage.setItem(RATE_KEY, String(v)) } catch { /* storage unavailable, keep in-memory value */ }
}

const EBAY_BLANK = { gross_sales: '', refunds: '', fees: '', shipping_labels: '', notes: '' }
const TCG_BLANK  = { net_sales: '', total_fees: '', refunded_fees: '', order_count: '', notes: '' }
const hasValues  = (o) => Object.entries(o).some(([k, v]) => k !== 'notes' && String(v).trim() !== '')

function Field({ label, hint, value, onChange, step = '0.01' }) {
  return (
    <div className="form-group">
      <label className="form-label">{label}</label>
      <input className="form-input" type="number" min="0" step={step} value={value} onChange={e => onChange(e.target.value)} placeholder="0" />
      <div className="text-muted" style={{ fontSize: 11, marginTop: 3 }}>{hint}</div>
    </div>
  )
}

const EstTag = () => <span className="text-muted" style={{ fontSize: 10, marginLeft: 4 }}>est.</span>

export default function Profit() {
  const [platformMonths, setPlatformMonths] = useState([])
  const [expenses,       setExpenses]       = useState([])
  const [boxes,          setBoxes]          = useState([])
  const [stock,          setStock]          = useState(null)   // { market, sellable } for cards on hand, all games
  const [loading,        setLoading]        = useState(true)
  const [missingTables,  setMissingTables]  = useState(false)
  const [year,           setYear]           = useState(new Date().getFullYear())
  const [rate,           setRate]           = useState(readRate)
  const [rateDraft,      setRateDraft]      = useState(() => String(readRate()))

  // Enter month modal
  const [monthModal,  setMonthModal]  = useState(false)
  const [monthForm,   setMonthForm]   = useState({ month: '', ebay: EBAY_BLANK, tcg: TCG_BLANK })
  const [monthSaving, setMonthSaving] = useState(false)

  // Add expense modal
  const [expModal,  setExpModal]  = useState(false)
  const [expForm,   setExpForm]   = useState({ spent_at: todayLocal(), category: 'postage', amount: '', notes: '' })
  const [expSaving, setExpSaving] = useState(false)

  async function load() {
    setLoading(true)
    const [pm, ex, bx] = await Promise.all([
      supabase.from('platform_months').select('*').order('month', { ascending: false }),
      supabase.from('expenses').select('*').order('spent_at', { ascending: false }),
      // All boxes, every game, ignoring exclude_from_pnl: this page is actual cash spent.
      // '*' rather than naming box_count so the page still loads if that column is missing.
      supabase.from('boxes').select('*').order('purchased_at', { ascending: false }),
    ])
    setMissingTables(!!(pm.error || ex.error))
    setPlatformMonths(pm.data ?? [])
    setExpenses(ex.data ?? [])
    setBoxes(bx.data ?? [])
    setLoading(false)
    loadStock()
  }

  // Whole-account card stock (all games), like the Dashboard's "incl. stock" figure.
  // quantity_owned includes listed-but-unsold copies, which are still on hand.
  // Paged because PostgREST caps responses at 1000 rows.
  async function loadStock() {
    let rows = [], page = 0
    while (true) {
      const { data, error } = await supabase.from('v_inventory_dashboard')
        .select('tcgplayer_market, quantity_owned')
        .gt('quantity_owned', 0)
        .range(page * 1000, (page + 1) * 1000 - 1)
      if (error) { setStock(null); return }
      rows = rows.concat(data ?? [])
      if (!data || data.length < 1000) break
      page++
    }
    let market = 0, sellableGross = 0
    for (const r of rows) {
      const v = num(r.tcgplayer_market) * num(r.quantity_owned)
      market += v
      if (num(r.tcgplayer_market) >= SELLABLE_MIN) sellableGross += v
    }
    setStock({ market, sellable: sellableGross * (1 - SELL_COST_PCT) })
  }

  useEffect(() => { load() }, [])

  const years = useMemo(() => {
    const ys = new Set([new Date().getFullYear()])
    for (const p of platformMonths) ys.add(Number(p.month.slice(0, 4)))
    for (const e of expenses)       ys.add(Number(e.spent_at.slice(0, 4)))
    for (const b of boxes)          if (b.purchased_at) ys.add(Number(b.purchased_at.slice(0, 4)))
    return [...ys].sort((a, b) => b - a)
  }, [platformMonths, expenses, boxes])

  const months = useMemo(() => {
    const prefix = `${year}-`
    const map = new Map()
    const get = (key) => {
      if (!map.has(key)) map.set(key, { key, ebay: null, tcg: null, boxSpend: 0, boxCount: 0, postageActual: 0, hasPostage: false, other: 0 })
      return map.get(key)
    }
    for (const p of platformMonths) {
      const k = monthKey(p.month); if (!k.startsWith(prefix)) continue
      get(k)[p.platform === 'ebay' ? 'ebay' : 'tcg'] = p
    }
    for (const b of boxes) {
      const k = monthKey(b.purchased_at); if (!k?.startsWith(prefix)) continue
      const m = get(k); m.boxSpend += num(b.purchase_price); m.boxCount += num(b.box_count) || 1
    }
    for (const e of expenses) {
      const k = monthKey(e.spent_at); if (!k.startsWith(prefix)) continue
      const m = get(k)
      if (e.category === 'postage') { m.postageActual += num(e.amount); m.hasPostage = true }
      else m.other += num(e.amount)
    }
    return [...map.values()].map(m => {
      const ebayNet  = platformNet(m.ebay)
      const tcgNet   = platformNet(m.tcg)
      const net      = (ebayNet ?? 0) + (tcgNet ?? 0)
      const postage  = m.hasPostage ? m.postageActual : num(m.tcg?.order_count) * rate
      const postageEst = !m.hasPostage && postage > 0
      const costs    = postage + m.other
      const profit   = net - m.boxSpend - costs
      return {
        ...m, ebayNet, tcgNet, net, postage, postageEst, costs, profit,
        roi: m.boxSpend > 0 ? profit / m.boxSpend : null,
        noSales: m.boxSpend > 0 && !m.ebay && !m.tcg,
      }
    }).sort((a, b) => b.key.localeCompare(a.key))
  }, [platformMonths, expenses, boxes, year, rate])

  const totals = useMemo(() => {
    const t = months.reduce((s, m) => ({
      ebayNet:  s.ebayNet + (m.ebayNet ?? 0),
      tcgNet:   s.tcgNet + (m.tcgNet ?? 0),
      net:      s.net + m.net,
      boxSpend: s.boxSpend + m.boxSpend,
      boxCount: s.boxCount + m.boxCount,
      costs:    s.costs + m.costs,
      profit:   s.profit + m.profit,
      anyEst:   s.anyEst || m.postageEst,
    }), { ebayNet: 0, tcgNet: 0, net: 0, boxSpend: 0, boxCount: 0, costs: 0, profit: 0, anyEst: false })
    return { ...t, roi: t.boxSpend > 0 ? t.profit / t.boxSpend : null }
  }, [months])

  // Unopened boxes count at cost: still sealed, so no card value to estimate yet
  const unopened     = boxes.filter(b => !b.opened_at)
  const unopenedCost = unopened.reduce((s, b) => s + num(b.purchase_price), 0)
  const unopenedQty  = unopened.reduce((s, b) => s + (num(b.box_count) || 1), 0)
  const onHand       = stock ? stock.market + unopenedCost : null
  const sellable     = stock ? stock.sellable + unopenedCost : null
  const profitInclStock = sellable != null ? totals.profit + sellable : null

  function saveRate() {
    const v = parseFloat(rateDraft)
    if (!(v >= 0)) { setRateDraft(String(rate)); return }
    setRate(v)
    writeRate(v)
  }

  // ── Enter month ──────────────────────────────────────────────────────────
  function formForMonth(key) {
    const ebay = platformMonths.find(p => p.platform === 'ebay'      && monthKey(p.month) === key)
    const tcg  = platformMonths.find(p => p.platform === 'tcgplayer' && monthKey(p.month) === key)
    const s = (v) => v != null ? String(v) : ''
    return {
      month: key,
      ebay: ebay ? {
        gross_sales: s(ebay.gross_sales), refunds: s(ebay.refunds), fees: s(ebay.fees),
        shipping_labels: s(ebay.shipping_labels), notes: ebay.notes ?? '',
      } : EBAY_BLANK,
      // Only the net fee is stored, so an edit shows it as Total Fees with Refunded Fees at 0
      tcg: tcg ? {
        net_sales: s(tcg.gross_sales), total_fees: s(tcg.fees), refunded_fees: '0',
        order_count: s(tcg.order_count), notes: tcg.notes ?? '',
      } : TCG_BLANK,
    }
  }

  function openMonthModal(key) {
    setMonthForm(formForMonth(key ?? todayLocal().slice(0, 7)))
    setMonthModal(true)
  }

  const ef = (field) => (v) => setMonthForm(prev => ({ ...prev, ebay: { ...prev.ebay, [field]: v } }))
  const tf = (field) => (v) => setMonthForm(prev => ({ ...prev, tcg:  { ...prev.tcg,  [field]: v } }))

  // Reports show refunds/fees/labels as negatives; store them as positive amounts
  const ebayPreview = num(monthForm.ebay.gross_sales) - Math.abs(num(monthForm.ebay.refunds)) - Math.abs(num(monthForm.ebay.fees)) - Math.abs(num(monthForm.ebay.shipping_labels))
  const tcgFees     = Math.abs(num(monthForm.tcg.total_fees)) - Math.abs(num(monthForm.tcg.refunded_fees))
  const tcgPreview  = num(monthForm.tcg.net_sales) - tcgFees

  async function saveMonth() {
    if (!monthForm.month) { alert('Pick a month.'); return }
    const month = `${monthForm.month}-01`
    const existing = (platform) => platformMonths.some(p => p.platform === platform && monthKey(p.month) === monthForm.month)
    const rows = []
    if (hasValues(monthForm.ebay) || existing('ebay')) {
      rows.push({
        month, platform: 'ebay',
        gross_sales:     num(monthForm.ebay.gross_sales),
        refunds:         Math.abs(num(monthForm.ebay.refunds)),
        fees:            Math.abs(num(monthForm.ebay.fees)),
        shipping_labels: Math.abs(num(monthForm.ebay.shipping_labels)),
        order_count:     null,
        notes:           monthForm.ebay.notes.trim() || null,
      })
    }
    if (hasValues(monthForm.tcg) || existing('tcgplayer')) {
      rows.push({
        month, platform: 'tcgplayer',
        gross_sales:     num(monthForm.tcg.net_sales),
        refunds:         0,
        fees:            Math.round(tcgFees * 100) / 100,
        shipping_labels: 0,
        order_count:     monthForm.tcg.order_count === '' ? null : parseInt(monthForm.tcg.order_count) || 0,
        notes:           monthForm.tcg.notes.trim() || null,
      })
    }
    if (!rows.length) { alert('Enter at least one platform\'s numbers.'); return }
    setMonthSaving(true)
    const { error } = await supabase.from('platform_months').upsert(rows, { onConflict: 'month,platform' })
    setMonthSaving(false)
    if (error) { alert(`Save failed: ${error.message}`); return }
    setMonthModal(false)
    load()
  }

  // ── Expenses ─────────────────────────────────────────────────────────────
  function openExpModal() {
    setExpForm({ spent_at: todayLocal(), category: 'postage', amount: '', notes: '' })
    setExpModal(true)
  }

  const xf = (field) => (e) => setExpForm(prev => ({ ...prev, [field]: e.target.value }))
  const expMonth = monthKey(expForm.spent_at)
  const monthExpenses = expenses.filter(e => monthKey(e.spent_at) === expMonth)

  async function addExpense() {
    const amount = parseFloat(expForm.amount)
    if (!expForm.spent_at || !(amount > 0)) return
    setExpSaving(true)
    const { error } = await supabase.from('expenses').insert({
      spent_at: expForm.spent_at,
      category: expForm.category,
      amount,
      notes:    expForm.notes.trim() || null,
    })
    setExpSaving(false)
    if (error) { alert(`Save failed: ${error.message}`); return }
    setExpForm(prev => ({ ...prev, amount: '', notes: '' }))
    load()
  }

  async function deleteExpense(row) {
    if (!confirm(`Delete ${row.category} expense of ${usd(row.amount)}?`)) return
    const { error } = await supabase.from('expenses').delete().eq('id', row.id)
    if (error) { alert(`Delete failed: ${error.message}`); return }
    load()
  }

  return (
    <div className="page">
      <div className="page-header flex-between">
        <div>
          <h1 className="page-title">Profit</h1>
          <p className="page-subtitle">Cash in after fees, minus boxes and expenses</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select className="form-select" value={year} onChange={e => setYear(Number(e.target.value))} style={{ width: 100 }}>
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <button className="btn btn-ghost" onClick={openExpModal}>+ Add expense</button>
          <button className="btn btn-primary" onClick={() => openMonthModal()}>+ Enter month</button>
        </div>
      </div>

      {missingTables && (
        <div className="panel" style={{ padding: '10px 14px', marginBottom: 16, fontSize: 12, color: 'var(--text-secondary)', borderColor: 'var(--gold)' }}>
          ⚠ Run 20261020_profit_tracking.sql in Supabase to create the platform_months and expenses tables.
        </div>
      )}

      {/* Summary metrics */}
      <div className="metrics-grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
        <div className="metric-card">
          <div className="metric-label">Platform net</div>
          <div className="metric-value gold">{usd(totals.net)}</div>
          <div className="metric-sub">after fees, refunds & labels</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Box spend</div>
          <div className="metric-value">{usd(totals.boxSpend)}</div>
          <div className="metric-sub">{totals.boxCount} box{totals.boxCount !== 1 ? 'es' : ''} bought</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Postage & supplies</div>
          <div className="metric-value">{usd(totals.costs)}{totals.anyEst && <EstTag />}</div>
          <div className="metric-sub">{totals.anyEst ? `incl. est. postage at ${usd(rate)}/order` : 'from logged expenses'}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Profit</div>
          <div className="metric-value" style={{ color: pnlColor(totals.profit) }}>{fmtPnl(totals.profit)}</div>
          <div className="metric-sub">{year} to date</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Return on boxes</div>
          <div className="metric-value" style={{ color: totals.roi != null ? pnlColor(totals.roi) : undefined }}>{pct(totals.roi)}</div>
          <div className="metric-sub">profit ÷ box spend</div>
        </div>
      </div>

      {/* Inventory still on hand — a current snapshot, not tied to the selected year */}
      <div className="metrics-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div className="metric-card">
          <div className="metric-label">Inventory on hand</div>
          <div className="metric-value gold">{usd(onHand)}</div>
          <div className="metric-sub">
            cards at market{unopenedQty > 0 ? ` + ${unopenedQty} sealed box${unopenedQty !== 1 ? 'es' : ''} at cost (${usd(unopenedCost)})` : ''}
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Sellable value</div>
          <div className="metric-value gold">{usd(sellable)}</div>
          <div className="metric-sub">cards ≥ ${SELLABLE_MIN}, less ~{Math.round(SELL_COST_PCT * 100)}% fees · market {usd(stock?.market)}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Profit incl. inventory</div>
          <div className="metric-value" style={{ color: profitInclStock != null ? pnlColor(profitInclStock) : undefined }}>{fmtPnl(profitInclStock)}</div>
          <div className="metric-sub">{year} cash profit + sellable value today</div>
        </div>
      </div>

      {/* Postage rate */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
        <span>Estimated postage per TCGplayer order</span>
        <input
          className="form-input"
          type="number"
          min="0"
          step="0.01"
          value={rateDraft}
          onChange={e => setRateDraft(e.target.value)}
          onBlur={saveRate}
          onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}
          style={{ width: 80 }}
        />
        <span className="text-muted">used for any month without logged postage expenses</span>
      </div>

      {/* Monthly table */}
      {loading ? (
        <div className="loading">Loading…</div>
      ) : months.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">💰</div>
          Nothing recorded for {year} yet. Use "+ Enter month" to add your platform reports.
        </div>
      ) : (
        <div className="panel">
          <table className="data-table">
            <thead>
              <tr>
                <th>Month</th>
                <th className="text-right">eBay net</th>
                <th className="text-right">TCGplayer net</th>
                <th className="text-right">Box spend</th>
                <th className="text-right">Postage & supplies</th>
                <th className="text-right">Profit</th>
                <th className="text-right">Return %</th>
              </tr>
            </thead>
            <tbody>
              {months.map(m => (
                <tr key={m.key} style={{ cursor: 'pointer' }} onClick={() => openMonthModal(m.key)}>
                  <td>
                    <div className="name-cell">{monthLabel(m.key)}</div>
                    {m.noSales && <span className="badge badge-alert" style={{ fontSize: 10 }}>No sales entered</span>}
                  </td>
                  <td className="text-right">{m.ebay ? usd(m.ebayNet) : <span className="text-muted">—</span>}</td>
                  <td className="text-right">{m.tcg ? usd(m.tcgNet) : <span className="text-muted">—</span>}</td>
                  <td className="text-right">
                    {m.boxSpend > 0 ? usd(m.boxSpend) : <span className="text-muted">—</span>}
                    {m.boxCount > 0 && <div className="text-muted" style={{ fontSize: 11 }}>{m.boxCount} box{m.boxCount !== 1 ? 'es' : ''}</div>}
                  </td>
                  <td className="text-right">
                    {usd(m.costs)}{m.postageEst && <EstTag />}
                  </td>
                  <td className="text-right" style={{ color: pnlColor(m.profit), fontWeight: 500 }}>{fmtPnl(m.profit)}</td>
                  <td className="text-right" style={{ color: m.roi != null ? pnlColor(m.roi) : undefined }}>{pct(m.roi)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 500 }}>
                <td style={{ borderTop: '1px solid var(--border)' }}>Total {year}</td>
                <td className="text-right" style={{ borderTop: '1px solid var(--border)' }}>{usd(totals.ebayNet)}</td>
                <td className="text-right" style={{ borderTop: '1px solid var(--border)' }}>{usd(totals.tcgNet)}</td>
                <td className="text-right" style={{ borderTop: '1px solid var(--border)' }}>{usd(totals.boxSpend)}</td>
                <td className="text-right" style={{ borderTop: '1px solid var(--border)' }}>{usd(totals.costs)}{totals.anyEst && <EstTag />}</td>
                <td className="text-right" style={{ borderTop: '1px solid var(--border)', color: pnlColor(totals.profit) }}>{fmtPnl(totals.profit)}</td>
                <td className="text-right" style={{ borderTop: '1px solid var(--border)', color: totals.roi != null ? pnlColor(totals.roi) : undefined }}>{pct(totals.roi)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* ── Enter month modal ─────────────────────────────────────────────── */}
      {monthModal && (
        <div className="modal-overlay" onClick={() => setMonthModal(false)}>
          <div className="modal" style={{ maxWidth: 620 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Enter month</span>
              <button className="btn btn-ghost btn-sm" onClick={() => setMonthModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-group" style={{ maxWidth: 220 }}>
                <label className="form-label">Month</label>
                <input
                  className="form-input"
                  type="month"
                  value={monthForm.month}
                  onChange={e => setMonthForm(e.target.value ? formForMonth(e.target.value) : { ...monthForm, month: '' })}
                />
              </div>

              <div style={{ background: 'var(--bg-void)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px', marginBottom: 12 }}>
                <div className="flex-between" style={{ marginBottom: 10 }}>
                  <span style={{ fontSize: 11, color: 'var(--gold)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>eBay</span>
                  <span style={{ fontSize: 12 }}>Net <span style={{ color: pnlColor(ebayPreview), fontWeight: 500 }}>{usd(ebayPreview)}</span></span>
                </div>
                <div className="form-row">
                  <Field label="Order proceeds ($)" hint="Financial overview → Order proceeds" value={monthForm.ebay.gross_sales} onChange={ef('gross_sales')} />
                  <Field label="Refunds ($)" hint="Refunds (enter as a positive number)" value={monthForm.ebay.refunds} onChange={ef('refunds')} />
                </div>
                <div className="form-row">
                  <Field label="Fees ($)" hint="Expenses → Fees" value={monthForm.ebay.fees} onChange={ef('fees')} />
                  <Field label="Shipping labels ($)" hint="Expenses → Shipping labels" value={monthForm.ebay.shipping_labels} onChange={ef('shipping_labels')} />
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">Notes</label>
                  <input className="form-input" value={monthForm.ebay.notes} onChange={e => ef('notes')(e.target.value)} />
                </div>
              </div>

              <div style={{ background: 'var(--bg-void)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}>
                <div className="flex-between" style={{ marginBottom: 10 }}>
                  <span style={{ fontSize: 11, color: 'var(--gold)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>TCGplayer</span>
                  <span style={{ fontSize: 12 }}>Net <span style={{ color: pnlColor(tcgPreview), fontWeight: 500 }}>{usd(tcgPreview)}</span></span>
                </div>
                <div className="form-row">
                  <Field label="Net sales ($)" hint="Sales Summary → Net Sales" value={monthForm.tcg.net_sales} onChange={tf('net_sales')} />
                  <Field label="Order count" hint="Sales Summary → Order Count" value={monthForm.tcg.order_count} onChange={tf('order_count')} step="1" />
                </div>
                <div className="form-row">
                  <Field label="Total fees ($)" hint="Sales Summary → Total Fees" value={monthForm.tcg.total_fees} onChange={tf('total_fees')} />
                  <Field label="Refunded fees ($)" hint="Sales Summary → Refunded Fees" value={monthForm.tcg.refunded_fees} onChange={tf('refunded_fees')} />
                </div>
                <div className="text-muted" style={{ fontSize: 11, marginBottom: 10 }}>
                  Fees saved as Total Fees − Refunded Fees = {usd(tcgFees)}
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">Notes</label>
                  <input className="form-input" value={monthForm.tcg.notes} onChange={e => tf('notes')(e.target.value)} />
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setMonthModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveMonth} disabled={monthSaving || !monthForm.month}>
                {monthSaving ? 'Saving…' : 'Save month'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add expense modal ─────────────────────────────────────────────── */}
      {expModal && (
        <div className="modal-overlay" onClick={() => setExpModal(false)}>
          <div className="modal" style={{ maxWidth: 500 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Add expense</span>
              <button className="btn btn-ghost btn-sm" onClick={() => setExpModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Date</label>
                  <input className="form-input" type="date" value={expForm.spent_at} onChange={xf('spent_at')} />
                </div>
                <div className="form-group">
                  <label className="form-label">Category</label>
                  <select className="form-select" value={expForm.category} onChange={xf('category')}>
                    {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Amount ($) *</label>
                  <input className="form-input" type="number" min="0" step="0.01" value={expForm.amount} onChange={xf('amount')} placeholder="e.g. 24.50" />
                </div>
                <div className="form-group">
                  <label className="form-label">Notes</label>
                  <input className="form-input" value={expForm.notes} onChange={xf('notes')} placeholder="e.g. 200 toploaders" />
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
                <button className="btn btn-primary btn-sm" onClick={addExpense} disabled={expSaving || !(parseFloat(expForm.amount) > 0) || !expForm.spent_at}>
                  {expSaving ? 'Saving…' : '+ Add expense'}
                </button>
              </div>

              <div style={{ background: 'var(--bg-void)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '8px 12px', borderBottom: '1px solid var(--border)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                  {expMonth ? monthLabel(expMonth) : 'This month'} expenses
                </div>
                {monthExpenses.length === 0 ? (
                  <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-muted)' }}>No expenses logged for this month.</div>
                ) : monthExpenses.map(row => (
                  <div key={row.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                    <span className="text-muted" style={{ fontSize: 12, width: 48 }}>{row.spent_at.slice(5)}</span>
                    <span className="badge" style={{ fontSize: 10 }}>{row.category}</span>
                    <span style={{ flex: 1, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.notes ?? ''}</span>
                    <span style={{ fontWeight: 500 }}>{usd(row.amount)}</span>
                    <button
                      onClick={() => deleteExpense(row)}
                      title="Delete expense"
                      style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' }}
                    >×</button>
                  </div>
                ))}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setExpModal(false)}>Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
