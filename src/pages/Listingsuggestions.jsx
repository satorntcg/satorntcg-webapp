import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useGame } from '../context/GameContext'
import { gameConfig } from '../lib/games'

const usd    = (n) => n == null ? '—' : `$${Number(n).toFixed(2)}`
const fmtPnl = (n) => { if (n == null) return '—'; const v = Number(n); return `${v >= 0 ? '+$' : '-$'}${Math.abs(v).toFixed(2)}` }
const cap    = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s

const EBAY_FEE_PCT  = 0.129
const EBAY_FEE_FLAT = 0.30
const DEFAULT_SHIP  = 5.50
const calcNet = (price) => price - (price * EBAY_FEE_PCT + EBAY_FEE_FLAT) - DEFAULT_SHIP

const SOLO_COLORS = ['var(--gold-light)', 'var(--gold)', '#C9A84C', '#B08D3A']

// ── Grouping logic ────────────────────────────────────────────
function groupCards(cards, config) {
  const { soloRarities = [], secondaryRarity = null, pooledSpecialType = null, pooledSpecialLabel = null } = config.grouping

  // Expand each card by available_qty so multiple owned copies can fill separate lots
  const expanded = cards.flatMap(c => {
    const qty = Math.max(1, Number(c.available_qty ?? 1))
    return Array.from({ length: qty }, () => c)
  })

  const groups = []
  const isPooled = c => pooledSpecialType && c.card_type === pooledSpecialType

  // expanded is already pre-filtered by the available check; just split into tiers.
  // The pooled special type (e.g. Sorcery's "site" cards) always goes into its own
  // pool regardless of rarity — collectors buy those lots specifically.
  const pooled       = expanded.filter(c => isPooled(c) && !c.foil)
  const pooledFoils  = expanded.filter(c => isPooled(c) &&  c.foil)

  // Helper: pack cards into lots of max 6, only emit if total >= $20
  function packIntoLots(cardList, tierLabel, color) {
    // Sort highest value first so best cards anchor each lot
    const sorted = [...cardList].sort((a, b) => (b.tcgplayer_market || 0) - (a.tcgplayer_market || 0))
    let current = []
    let currentTotal = 0

    for (const card of sorted) {
      const price = card.tcgplayer_market || 0

      // If this single card alone hits $20, emit it solo
      if (price >= 20 && current.length === 0) {
        groups.push({ tier: tierLabel, cards: [card], total: price, color })
        continue
      }

      current.push(card)
      currentTotal += price

      // Emit when we hit 6 cards or total >= $20
      if (current.length >= 6 || currentTotal >= 20) {
        if (currentTotal >= 20) {
          groups.push({ tier: tierLabel, cards: [...current], total: currentTotal, color })
          current = []; currentTotal = 0
        } else if (current.length >= 6) {
          // Hit 6 cards but not $20 — keep as partial
          groups.push({ tier: tierLabel, cards: [...current], total: currentTotal, color, partial: true })
          current = []; currentTotal = 0
        }
      }
    }

    // Remaining cards
    if (current.length > 0) {
      if (currentTotal >= 20) {
        groups.push({ tier: tierLabel, cards: [...current], total: currentTotal, color })
      } else {
        // Try to merge into last lot of same tier
        const lastSameTier = [...groups].reverse().find(g => g.tier === tierLabel && !g.partial)
        if (lastSameTier && lastSameTier.cards.length + current.length <= 6) {
          lastSameTier.cards.push(...current)
          lastSameTier.total += currentTotal
        } else {
          // Show as partial — under $20, needs attention
          groups.push({ tier: tierLabel, cards: [...current], total: currentTotal, color, partial: true })
        }
      }
    }
  }

  // 1. Solo rarities (e.g. Sorcery's "unique", Riftbound's "epic"/"overnumbered"):
  //    foil and non-foil keep separate lots — high value, worth distinguishing
  soloRarities.forEach((rarity, i) => {
    const color = SOLO_COLORS[i % SOLO_COLORS.length]
    const rarityCards = expanded.filter(c => c.rarity === rarity && !isPooled(c))
    packIntoLots(rarityCards.filter(c =>  c.foil), `${cap(rarity)} Foil`, color)
    packIntoLots(rarityCards.filter(c => !c.foil), cap(rarity),          color)
  })

  // 2. Pooled special type: their own pool regardless of rarity
  if (pooledSpecialType) {
    packIntoLots(pooledFoils, `${pooledSpecialLabel} Foil`, '#7ADBA0')
    packIntoLots(pooled,      pooledSpecialLabel,           '#5A9E78')
  }

  // 3. All remaining (non-solo, non-pooled) foils pool together — reaching $20 is easier mixed
  const allFoils = expanded.filter(c => c.foil && !soloRarities.includes(c.rarity) && !isPooled(c))
  packIntoLots(allFoils, 'Foil', '#7AADEC')

  // 4. Secondary rarity non-foils (one tier below the solo rarities)
  if (secondaryRarity) {
    const secondary = expanded.filter(c => !c.foil && c.rarity === secondaryRarity && !isPooled(c))
    packIntoLots(secondary, cap(secondaryRarity), '#9A9080')
  }

  return groups
}

// ── AI title + analysis via Edge Function ────────────────────
async function getAISuggestions(groups) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-listing-suggestions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session?.access_token ?? import.meta.env.VITE_SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ groups }),
  })
  const data = await res.json()
  if (data?.error) throw new Error(data.error)
  return data.suggestions
}

// ── Create listing ────────────────────────────────────────────
async function createListing(group, aiSuggestion, config) {
  const title = aiSuggestion?.title || (
    group.cards.length === 1
      ? `${group.cards[0].name}${group.cards[0].foil ? ' (Foil)' : ''} — ${config.displayName}${group.cards[0].set_name ? ` ${group.cards[0].set_name}` : ''}`
      : `${config.displayName} Lot — ${group.tier} — ${group.cards.length} Cards`
  )

  const cardBreakdown  = group.cards.map(c => `${c.name} ($${(c.tcgplayer_market || 0).toFixed(2)})`).join(', ')

  const { data: listing, error } = await supabase.from('ebay_listings').insert({
    card_id:       group.cards.length === 1 ? group.cards[0].id : null,
    title,
    listed_price:  parseFloat(group.total.toFixed(2)),
    shipping_cost: DEFAULT_SHIP,
    condition:     'Near Mint',
    notes:         `Cards: ${cardBreakdown}\nAI note: ${aiSuggestion?.note || ''}`,
    status:        'active',
  }).select('id').single()

  if (error) throw error

  // Build per-card quantity map (same card can appear multiple times when qty > 1)
  const cardQtyMap = {}
  for (const c of group.cards) {
    cardQtyMap[c.id] = { card: c, qty: (cardQtyMap[c.id]?.qty ?? 0) + 1 }
  }

  // Link all cards in junction table, one row per unique card with quantity
  if (listing && group.cards.length > 0) {
    const perCardPrice = parseFloat((group.total / group.cards.length).toFixed(2))
    await supabase.from('ebay_listing_cards').insert(
      Object.entries(cardQtyMap).map(([cardId, { qty }]) => ({
        listing_id: listing.id,
        card_id: cardId,
        price: perCardPrice,
        quantity: qty,
      }))
    )
  }

  // Increment quantity_listed for each card by how many copies are in this group
  for (const [cardId, { qty }] of Object.entries(cardQtyMap)) {
    const { data: cardRow } = await supabase.from('cards').select('quantity_listed').eq('id', cardId).single()
    if (cardRow) {
      await supabase.from('cards').update({ quantity_listed: (cardRow.quantity_listed ?? 0) + qty }).eq('id', cardId)
    }
  }

  return listing
}

// ── Main component ────────────────────────────────────────────
export default function ListingSuggestions() {
  const { activeGame } = useGame()
  const config = gameConfig(activeGame.slug)
  const [cards, setCards]         = useState([])
  const [groups, setGroups]       = useState([])
  const [aiData, setAiData]       = useState([])
  const [loading, setLoading]     = useState(true)
  const [analyzing, setAnalyzing] = useState(false)
  const [creating, setCreating]   = useState({})
  const [created, setCreated]     = useState(new Set())
  const [error, setError]         = useState('')
  const [filterTier, setFilterTier] = useState(null)

  useEffect(() => {
    async function load() {
      setLoading(true)
      const { eligibleRarities, pooledSpecialType } = config.grouping

      let orFilter = `rarity.in.(${eligibleRarities.join(',')}),foil.eq.true`
      if (pooledSpecialType) orFilter += `,card_type.eq.${pooledSpecialType}`

      const [{ data, error: fetchErr }, { data: lotData }] = await Promise.all([
        supabase
          .from('v_inventory_dashboard')
          .select('id, name, set_name, rarity, foil, card_type, tcgplayer_market, cost_basis, quantity_owned, quantity_listed, quantity_available, active_listing_count')
          .eq('game_id', activeGame.id)
          .or(orFilter)
          .gt('quantity_owned', 0)
          .order('tcgplayer_market', { ascending: false }),
        // Fetch card IDs in active lot listings (card_id is null on the listing itself)
        supabase
          .from('ebay_listing_cards')
          .select('card_id, quantity, ebay_listings!listing_id(status)')
      ])
      if (fetchErr) { setError(`Failed to load inventory: ${fetchErr.message}`); setLoading(false); return }

      // Build map: card_id → total quantity in active lot listings
      const lotListedMap = {}
      for (const lc of (lotData ?? [])) {
        if (lc.ebay_listings?.status === 'active' && lc.card_id) {
          lotListedMap[lc.card_id] = (lotListedMap[lc.card_id] ?? 0) + (lc.quantity ?? 1)
        }
      }

      // Filter: eligible rarity/foil/pooled type, has truly available copies, has a price
      // active_listing_count = active single-card ebay_listings (card_id is set)
      // lotListed = active lot listings from ebay_listing_cards
      // Don't use quantity_listed (cards table column) — createListing increments it for lot
      // listings too, which would double-count with lotListedMap.
      const available = (data ?? []).filter(c => {
        const owned      = Number(c.quantity_owned ?? 0)
        const singleList = Number(c.active_listing_count ?? 0)
        const lotListed  = lotListedMap[c.id] ?? 0
        const price      = Number(c.tcgplayer_market ?? 0)
        return (eligibleRarities.includes(c.rarity) || c.foil || (pooledSpecialType && c.card_type === pooledSpecialType)) && owned > (singleList + lotListed) && price > 0
      })

      const withPooled = available.map(c => {
        const owned      = Number(c.quantity_owned ?? 0)
        const singleList = Number(c.active_listing_count ?? 0)
        const lotListed  = lotListedMap[c.id] ?? 0
        return {
          ...c,
          card_id: c.id,
          is_pooled: Boolean(pooledSpecialType) && c.card_type === pooledSpecialType,
          available_qty: Math.max(0, owned - singleList - lotListed),
        }
      })

      setCards(withPooled)
      const grouped = groupCards(withPooled, config)
      setGroups(grouped)
      setLoading(false)
    }
    load()
  }, [activeGame.id])

  async function runAI() {
    if (!groups.length) return
    setAnalyzing(true); setError('')
    try {
      const suggestions = await getAISuggestions(groups)
      setAiData(suggestions)
    } catch (e) {
      setError(`AI analysis failed: ${e.message}`)
    }
    setAnalyzing(false)
  }

  async function handleCreate(groupIdx) {
    setCreating(prev => ({ ...prev, [groupIdx]: true }))
    try {
      await createListing(groups[groupIdx], aiData[groupIdx], config)
      setCreated(prev => new Set([...prev, groupIdx]))
    } catch (e) {
      setError(`Failed to create listing: ${e.message}`)
    }
    setCreating(prev => ({ ...prev, [groupIdx]: false }))
  }

  const totalLots   = groups.length
  const totalValue  = groups.reduce((s, g) => s + g.total, 0)
  const totalNet    = groups.reduce((s, g) => s + calcNet(g.total), 0)
  const unlistedCount = cards.length

  // Derive tiers from groups preserving order and color
  const tiers = []
  const seenTiers = new Set()
  for (const g of groups) {
    if (!seenTiers.has(g.tier)) { tiers.push({ tier: g.tier, color: g.color }); seenTiers.add(g.tier) }
  }

  const visibleGroups = filterTier ? groups.filter(g => g.tier === filterTier) : groups

  if (loading) return <div className="page"><div className="loading">Analysing inventory…</div></div>

  return (
    <div className="page">
      <div className="page-header flex-between">
        <div>
          <h1 className="page-title">Listing Suggestions</h1>
          <p className="page-subtitle">
            {unlistedCount} unlisted cards · {totalLots} suggested lots · {usd(totalValue)} total value
          </p>
        </div>
        <button
          className="btn btn-primary"
          onClick={runAI}
          disabled={analyzing || !groups.length}
        >
          {analyzing ? '⟳ Analysing…' : '✦ AI analyse lots'}
        </button>
      </div>

      {error && (
        <div className="alert-item danger mb-16">
          <span className="alert-icon">✗</span>
          <div className="alert-content"><div className="alert-desc">{error}</div></div>
        </div>
      )}

      {/* Summary metrics */}
      <div className="metrics-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 24 }}>
        <div className="metric-card">
          <div className="metric-label">Unlisted cards</div>
          <div className="metric-value">{unlistedCount}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Suggested lots</div>
          <div className="metric-value gold">{totalLots}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Total listed value</div>
          <div className="metric-value gold">{usd(totalValue)}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Net if all sell</div>
          <div className="metric-value" style={{ color: totalNet >= 0 ? 'var(--success)' : 'var(--danger)' }}>
            {fmtPnl(totalNet)}
          </div>
          <div className="metric-sub">after fees & shipping</div>
        </div>
      </div>

      {/* Tier filter buttons */}
      {tiers.length > 1 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setFilterTier(null)}
            style={!filterTier ? { borderColor: 'var(--gold)', color: 'var(--gold)' } : {}}
          >
            All ({groups.length})
          </button>
          {tiers.map(({ tier, color }) => {
            const count = groups.filter(g => g.tier === tier).length
            const active = filterTier === tier
            return (
              <button
                key={tier}
                className="btn btn-ghost btn-sm"
                onClick={() => setFilterTier(active ? null : tier)}
                style={active ? { borderColor: color, color, background: `${color}18` } : {}}
              >
                {tier} ({count})
              </button>
            )
          })}
        </div>
      )}

      {groups.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">{cards.length === 0 ? '📭' : '🎉'}</div>
          {cards.length === 0
            ? 'No unlisted high-rarity/foil cards with TCGPlayer prices found — run a price check first.'
            : 'All eligible cards are already listed on eBay!'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {visibleGroups.map((group) => {
            const i        = groups.indexOf(group)
            const ai       = aiData[i]
            const net      = calcNet(group.total)
            const isCreated = created.has(i)
            const isCreating = creating[i]

            return (
              <div
                key={i}
                className="panel"
                style={{
                  opacity: isCreated ? 0.5 : 1,
                  borderLeft: `3px solid ${group.color}`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ flex: 1 }}>
                    {/* Tier badge */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{
                        fontSize: 10, fontWeight: 600, letterSpacing: '0.1em',
                        textTransform: 'uppercase', color: group.color,
                        background: `${group.color}18`,
                        border: `1px solid ${group.color}40`,
                        borderRadius: 4, padding: '2px 8px',
                      }}>
                        {group.tier}
                      </span>
                      {group.partial && (
                        <span className="badge badge-alert">Under $20</span>
                      )}
                      {ai?.synergy && (
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {'★'.repeat(ai.synergy)}{'☆'.repeat(5 - ai.synergy)} synergy
                        </span>
                      )}
                    </div>

                    {/* AI title or default */}
                    <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 4 }}>
                      {ai?.title || `${config.displayName} — ${group.tier} Lot (${group.cards.length} cards)`}
                    </div>

                    {/* AI note */}
                    {ai?.note && (
                      <div style={{ fontSize: 12, color: 'var(--gold-dim)', marginBottom: 8, fontStyle: 'italic' }}>
                        ✦ {ai.note}
                      </div>
                    )}

                    {/* Cards */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {group.cards.map((card, j) => (
                        <div
                          key={j}
                          title="Open market check"
                          onClick={() => window.open(`/market?card=${card.id}`, '_blank')}
                          style={{
                            fontSize: 11, padding: '3px 8px',
                            background: 'var(--bg-raised)',
                            border: '1px solid var(--border)',
                            borderRadius: 4,
                            color: card.foil ? 'var(--gold-light)' : 'var(--text-secondary)',
                            cursor: 'pointer',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--gold)'; e.currentTarget.style.color = 'var(--gold)' }}
                          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = card.foil ? 'var(--gold-light)' : 'var(--text-secondary)' }}
                        >
                          {card.name}{card.foil ? ' ✦' : ''}{card.is_pooled ? ' ⬡' : ''} · {usd(card.tcgplayer_market)}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Pricing + action */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, marginLeft: 20, flexShrink: 0 }}>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 22, fontWeight: 300, color: 'var(--gold-light)' }}>{usd(group.total)}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        net {usd(net)} · {group.cards.length} card{group.cards.length !== 1 ? 's' : ''}
                      </div>
                    </div>

                    {isCreated ? (
                      <span className="badge badge-ok">Listed ✓</span>
                    ) : (
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => handleCreate(i)}
                        disabled={isCreating}
                      >
                        {isCreating ? '⟳ Creating…' : '+ Create listing'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}