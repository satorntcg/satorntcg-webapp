import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { Link, useNavigate } from 'react-router-dom'
import WeeklyMovers from '../components/Weeklymovers'
import { useGame } from '../context/GameContext'
import { gameConfig } from '../lib/games'

const toNumber = (value) => {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function getMarketValue(card) {
  const directValue = toNumber(card.market_value ?? card.total_market_value)
  if (directValue != null) return directValue
  const price = toNumber(card.tcgplayer_market ?? card.ebay_sold_avg)
  const quantity = toNumber(card.quantity_owned) ?? 0
  return price != null ? price * quantity : null
}

function getUnrealizedPnl(card) {
  const directPnl = toNumber(card.unrealized_pnl ?? card.unrealized_pnl_total)
  if (directPnl != null) return directPnl
  const perCardPnl = toNumber(card.unrealized_pnl_per_card)
  const quantity = toNumber(card.quantity_owned) ?? 0
  return perCardPnl != null ? perCardPnl * quantity : null
}

const pnlClass  = (v) => v == null ? 'text-muted' : v >= 0 ? 'text-success' : 'text-danger'
const formatPnl = (v) => v != null ? `${v >= 0 ? '+' : ''}${usd(v)}` : '—'
const usd       = (n) => n != null ? `$${Number(n).toFixed(2)}` : '—'
// Positive = still short of recouping box spend; zero/negative = already recouped (and ahead).
const formatRecovery = (v) => v == null ? '…' : v <= 0 ? `+${usd(-v)} surplus` : `${usd(v)} unrecovered`
const pct       = (n) => n != null ? `${n > 0 ? '+' : ''}${Number(n).toFixed(1)}%` : '—'
const fmtPct    = (n) => { if (n == null) return '—'; const v = Number(n); return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%` }
const fmtDate   = (d) => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

function PriceChange({ value }) {
  if (value == null) return <span className="text-muted">—</span>
  const cls   = value > 0 ? 'price-up' : value < 0 ? 'price-down' : 'price-flat'
  const arrow = value > 0 ? '↑' : value < 0 ? '↓' : '→'
  return <span className={cls}>{arrow} {pct(value)}</span>
}

export default function Dashboard() {
  const navigate = useNavigate()
  const { activeGame, decrementAlertCount } = useGame()
  const config = gameConfig(activeGame.slug)
  const [inventory, setInventory] = useState([])
  const [alerts, setAlerts]       = useState([])
  const [loading, setLoading]     = useState(true)
  const [pnl, setPnl]             = useState(null)
  const [boxCosts, setBoxCosts]   = useState(null)
  const [allGamesStockValue, setAllGamesStockValue] = useState(null)
  const [unlinked, setUnlinked]   = useState({ ebay: 0, tcgplayer: 0 })
  const [noStock, setNoStock]     = useState({ ebay: [], tcgplayer: [] })
  const [unlinkedLoading, setUnlinkedLoading] = useState(true)

  useEffect(() => {
    async function load() {
      setLoading(true)
      let allCards = [], batchPage = 0
      while (true) {
        const { data } = await supabase.from('v_inventory_dashboard').select('*').eq('game_id', activeGame.id).order('name')
          .range(batchPage * 1000, (batchPage + 1) * 1000 - 1)
        allCards = [...allCards, ...(data ?? [])]
        if (!data || data.length < 1000) break
        batchPage++
      }
      const alertRes = await supabase.from('v_active_alerts').select('*').eq('game_id', activeGame.id).gte('new_price', 1)
      setInventory(
        allCards
          .filter(c => (c.quantity_owned ?? 0) > 0)
          .sort((a, b) => (getMarketValue(b) ?? 0) - (getMarketValue(a) ?? 0))
      )
      setAlerts(alertRes.data ?? [])
      setLoading(false)
    }
    load()
  }, [activeGame.id])

  useEffect(() => {
    supabase.from('v_combined_pnl').select('*').single().then(({ data }) => setPnl(data))
    supabase.from('boxes').select('purchase_price').then(({ data }) => {
      if (data) setBoxCosts(data.reduce((s, b) => s + (b.purchase_price || 0), 0))
    })
    // Whole-account current stock value (all games), to pair with boxCosts/pnl above which are
    // also deliberately not game-scoped — mixing a game-scoped stock value in here would make
    // the "incl. stock" recovery figure inconsistent with the rest of the Business P&L panel.
    ;(async () => {
      let rows = [], page = 0
      while (true) {
        const { data } = await supabase.from('v_inventory_dashboard')
          .select('market_value, tcgplayer_market, ebay_sold_avg, quantity_owned')
          .range(page * 1000, (page + 1) * 1000 - 1)
        rows = [...rows, ...(data ?? [])]
        if (!data || data.length < 1000) break
        page++
      }
      const total = rows
        .filter(c => (c.quantity_owned ?? 0) > 0)
        .reduce((s, c) => s + (getMarketValue(c) ?? 0), 0)
      setAllGamesStockValue(total)
    })()
    // Two distinct problems, both meaning "this listing has no physical card behind it":
    //  - unlinked: no card_id, no card_name, no lot cards at all
    //  - noStock: linked to a real card (directly or via a lot), but that card's quantity_owned is 0
    // Not game-scoped since unlinked rows have no computed game_id, and a listing can outlive
    // whichever game happens to be active.
    Promise.all([
      supabase.from('v_ebay_active').select('id, title, card_id, card_name, all_card_names, card_count'),
      supabase.from('v_tcgplayer_active').select('id, title, card_id, card_name, all_card_names, card_count'),
      supabase.from('ebay_listing_cards').select('listing_id, card_id'),
      supabase.from('tcgplayer_listing_cards').select('listing_id, card_id'),
      supabase.from('cards').select('id, quantity_owned'),
    ]).then(([ebayRes, tcgRes, ebayLcRes, tcgLcRes, cardsRes]) => {
      const ownedMap = new Map((cardsRes.data ?? []).map(c => [c.id, c.quantity_owned ?? 0]))
      const lotCardsByListing = (rows) => {
        const m = new Map()
        for (const r of rows ?? []) {
          if (!m.has(r.listing_id)) m.set(r.listing_id, [])
          m.get(r.listing_id).push(r.card_id)
        }
        return m
      }
      const ebayLots = lotCardsByListing(ebayLcRes.data)
      const tcgLots  = lotCardsByListing(tcgLcRes.data)

      function classify(rows, lots) {
        let unlinkedCount = 0
        const outOfStock = []
        for (const l of (rows ?? [])) {
          const cardIds = l.card_id ? [l.card_id] : (lots.get(l.id) ?? [])
          if (cardIds.length === 0) { unlinkedCount++; continue }
          const owned = cardIds.reduce((s, id) => s + (ownedMap.get(id) ?? 0), 0)
          if (owned <= 0) outOfStock.push(l)
        }
        return { unlinkedCount, outOfStock }
      }

      const ebayClassified = classify(ebayRes.data, ebayLots)
      const tcgClassified  = classify(tcgRes.data, tcgLots)

      setUnlinked({ ebay: ebayClassified.unlinkedCount, tcgplayer: tcgClassified.unlinkedCount })
      setNoStock({ ebay: ebayClassified.outOfStock, tcgplayer: tcgClassified.outOfStock })
      setUnlinkedLoading(false)
    })
  }, [])

  async function dismissAlert(id) {
    await supabase.from('price_alerts').update({ dismissed: true }).eq('id', id)
    setAlerts(prev => prev.filter(a => a.id !== id))
    decrementAlertCount()
  }

  const totalMarketValue   = inventory.reduce((s, c) => s + (getMarketValue(c) ?? 0), 0)
  const totalUnrealizedPnl = inventory.reduce((s, c) => s + (getUnrealizedPnl(c) ?? 0), 0)
  const totalCards         = inventory.reduce((s, c) => s + (Number(c.quantity_owned) || 0), 0)
  const topMovers          = [...inventory]
    .filter(c => c.tcgplayer_market)
    .sort((a, b) => Math.abs(getUnrealizedPnl(b) ?? 0) - Math.abs(getUnrealizedPnl(a) ?? 0))
    .slice(0, 6)

  const totalNetProfit = pnl ? Number(pnl.total_net_profit) : 0
  const totalCogs       = pnl ? Number(pnl.total_cogs) : 0
  const businessProfit  = pnl && boxCosts != null ? totalNetProfit - (boxCosts - totalCogs) : null

  // How much of all-time box spend hasn't been recouped by realized profit yet. Unlike
  // businessProfit above (which nets cogs out of both sides to avoid double-counting box
  // costs against unsold stock), this pair intentionally treats "spent" and "profit" as
  // the user asked for them: total box spend vs. total realized profit, full stop — then
  // the second version adds back current stock value as the more complete picture.
  const unrecoveredSpend = pnl && boxCosts != null ? boxCosts - totalNetProfit : null
  const unrecoveredSpendWithStock = unrecoveredSpend != null && allGamesStockValue != null
    ? unrecoveredSpend - allGamesStockValue
    : null

  if (loading) return <div className="loading">Loading dashboard…</div>

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
        <p className="page-subtitle">Your {config.displayName} collection at a glance</p>
      </div>

      {/* Metrics */}
      <div className="metrics-grid">
        <div className="metric-card">
          <div className="metric-label">Portfolio Value</div>
          <div className="metric-value gold">{usd(totalMarketValue)}</div>
          <div className="metric-sub">at current market prices</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Unrealized P&L</div>
          <div className="metric-value" style={{ color: totalUnrealizedPnl >= 0 ? 'var(--success)' : 'var(--danger)' }}>
            {totalUnrealizedPnl >= 0 ? '+' : ''}{usd(totalUnrealizedPnl)}
          </div>
          <div className="metric-sub">vs cost basis</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Cards Owned</div>
          <div className="metric-value">{totalCards}</div>
          <div className="metric-sub">across {inventory.length} unique cards</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Active Alerts</div>
          <div className="metric-value" style={{ color: alerts.length > 0 ? 'var(--gold)' : undefined }}>{alerts.length}</div>
          <div className="metric-sub">
            {alerts.length > 0
              ? <Link to="/alerts" style={{ color: 'var(--gold-dim)', textDecoration: 'none' }}>Review now →</Link>
              : 'all clear'}
          </div>
        </div>
      </div>

      {/* Weekly movers widget */}
      <WeeklyMovers gameId={activeGame.id} defaultSet={config.defaultSet} />

      {/* Business P&L — combines eBay + TCGPlayer so box costs aren't double-counted per channel */}
      {pnl && (
        <div className="panel mb-16">
          <div className="panel-header">
            <span className="panel-title">Business P&L</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>eBay + TCGPlayer combined</span>
          </div>
          <div style={{ padding: '16px' }}>
            <div className="metrics-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 16 }}>
              <div className="metric-card">
                <div className="metric-label">Total revenue</div>
                <div className="metric-value gold">{usd(pnl.total_revenue)}</div>
              </div>
              <div className="metric-card">
                <div className="metric-label">Fees + shipping paid</div>
                <div className="metric-value">{usd(pnl.total_fees + Number(pnl.total_shipping_paid ?? 0))}</div>
              </div>
              <div className="metric-card">
                <div className="metric-label">Cost of goods sold</div>
                <div className="metric-value">{usd(pnl.total_cogs)}</div>
              </div>
              <div className="metric-card">
                <div className="metric-label">Remaining inventory cost</div>
                <div className="metric-value">{boxCosts != null ? usd(boxCosts - totalCogs) : '…'}</div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 4px 0' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>Business net profit</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>revenue − fees − shipping − box costs</div>
              </div>
              <div className="metric-value" style={{ fontSize: 28, color: businessProfit == null ? 'var(--text-primary)' : businessProfit >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                {businessProfit != null ? formatPnl(businessProfit) : '…'}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 4px 0', marginTop: 12, borderTop: '1px solid var(--border-mid)' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>Total spent vs. total profit</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>all-time box spend − realized net profit</div>
              </div>
              <div className="metric-value" style={{ fontSize: 22, color: unrecoveredSpend == null ? 'var(--text-primary)' : unrecoveredSpend <= 0 ? 'var(--success)' : 'var(--danger)' }}>
                {formatRecovery(unrecoveredSpend)}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 4px 0' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>...including unsold stock</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>same, minus current market value of cards still owned</div>
              </div>
              <div className="metric-value" style={{ fontSize: 22, color: unrecoveredSpendWithStock == null ? 'var(--text-primary)' : unrecoveredSpendWithStock <= 0 ? 'var(--success)' : 'var(--danger)' }}>
                {formatRecovery(unrecoveredSpendWithStock)}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Listings without inventory backing them — either no card link at all, or linked to a card with 0 owned */}
      <div className="panel mb-16">
        <div className="panel-header">
          <span className="panel-title">Listings Without Inventory</span>
        </div>
        <div style={{ padding: '8px 12px' }}>
          {unlinkedLoading ? (
            <div className="loading" style={{ padding: '12px 4px' }}>Checking…</div>
          ) : unlinked.ebay === 0 && unlinked.tcgplayer === 0 && noStock.ebay.length === 0 && noStock.tcgplayer.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">✓</div>
              Every active listing is backed by owned inventory
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="alert-desc" style={{ padding: '4px 4px 0' }}>
                These active listings aren't backed by owned inventory — sales won't deduct stock correctly. Link them to a card, restock, or end the listing.
              </div>
              {unlinked.ebay > 0 && (
                <div className="alert-item danger">
                  <span className="alert-icon">⚠</span>
                  <div className="alert-content">
                    <div className="alert-title">{unlinked.ebay} eBay listing{unlinked.ebay === 1 ? '' : 's'} with no linked card</div>
                  </div>
                  <Link to="/listings?unlinked=1" className="btn btn-ghost btn-sm">Review →</Link>
                </div>
              )}
              {unlinked.tcgplayer > 0 && (
                <div className="alert-item danger">
                  <span className="alert-icon">⚠</span>
                  <div className="alert-content">
                    <div className="alert-title">{unlinked.tcgplayer} TCGPlayer listing{unlinked.tcgplayer === 1 ? '' : 's'} with no linked card</div>
                  </div>
                  <Link to="/tcgplayer-listings?unlinked=1" className="btn btn-ghost btn-sm">Review →</Link>
                </div>
              )}
              {noStock.ebay.map(l => (
                <div className="alert-item danger" key={`ebay-${l.id}`}>
                  <span className="alert-icon">⚠</span>
                  <div className="alert-content">
                    <div className="alert-title">{l.card_name || l.all_card_names} — 0 owned</div>
                    <div className="alert-desc">eBay: {l.title}</div>
                  </div>
                  <Link to={`/listings?highlight=${l.id}`} className="btn btn-ghost btn-sm">View →</Link>
                </div>
              ))}
              {noStock.tcgplayer.map(l => (
                <div className="alert-item danger" key={`tcg-${l.id}`}>
                  <span className="alert-icon">⚠</span>
                  <div className="alert-content">
                    <div className="alert-title">{l.card_name || l.all_card_names} — 0 owned</div>
                    <div className="alert-desc">TCGPlayer: {l.title}</div>
                  </div>
                  <Link to={`/tcgplayer-listings?highlight=${l.id}`} className="btn btn-ghost btn-sm">View →</Link>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Active alerts */}
      <div className="panel mb-16">
          <div className="panel-header">
            <span className="panel-title">Price Alerts</span>
            <Link to="/alerts" className="btn btn-ghost btn-sm">View all</Link>
          </div>
          <div style={{ padding: '8px 12px' }}>
            {alerts.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">✓</div>
                No alerts — prices look stable
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {alerts.map(a => (
                  <div key={a.id} className={`alert-item ${a.alert_type === 'price_spike' ? 'success' : 'danger'}`}>
                    <span className="alert-icon">{a.alert_type === 'price_spike' ? '↑' : '↓'}</span>
                    <div className="alert-content">
                      <div className="alert-title">{a.card_name}{a.foil ? ' ✦' : ''} — {a.set_name}</div>
                      <div className="alert-desc">{a.message}</div>
                      <div style={{ display: 'flex', gap: 10, marginTop: 4, alignItems: 'center' }}>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtDate(a.created_at)}</span>
                        {a.listing_id && (
                          <button onClick={() => navigate(`/listings?highlight=${a.listing_id}`)} style={{ fontSize: 11, color: 'var(--gold)', background: 'none', border: 'none', borderBottom: '1px dashed var(--gold)', padding: 0, cursor: 'pointer' }}>View listing →</button>
                        )}
                        {a.ebay_url && (
                          <a href={a.ebay_url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: 'var(--text-secondary)', textDecoration: 'none', borderBottom: '1px dashed var(--border-mid)' }}>eBay ↗</a>
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
                      <span style={{ fontSize: 16, fontWeight: 500, color: a.alert_type === 'price_spike' ? 'var(--success)' : 'var(--danger)' }}>
                        {fmtPct(a.pct_change)}
                      </span>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {usd(a.old_price)} → {usd(a.new_price)}
                      </div>
                      <button className="btn btn-ghost btn-sm" style={{ fontSize: 11 }} onClick={() => dismissAlert(a.id)}>Dismiss</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

      {/* Inventory overview */}
      {inventory.length > 0 && (
        <div className="panel mt-16">
          <div className="panel-header">
            <span className="panel-title">Top Holdings</span>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Card</th>
                <th>Set</th>
                <th>Rarity</th>
                <th className="text-right">Qty</th>
                <th className="text-right">eBay Avg</th>
                <th className="text-right">TCGPlayer</th>
              </tr>
            </thead>
            <tbody>
              {inventory.slice(0, 10).map(card => (
                <tr key={card.card_id ?? card.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/cards/${encodeURIComponent((card.name ?? '').toLowerCase().replace(/\s+/g, '-'))}/${card.card_id ?? card.id}`)}>
                  <td className="name-cell">{card.name}{card.foil ? ' ✦' : ''}</td>
                  <td className="text-muted">{card.set_name}</td>
                  <td><span className={`badge badge-${card.rarity}`}>{card.rarity}</span></td>
                  <td className="text-right">{card.quantity_owned}</td>
                  <td className="text-right text-muted">{usd(card.ebay_sold_avg)}</td>
                  <td className="text-right text-gold">{usd(card.tcgplayer_market)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}