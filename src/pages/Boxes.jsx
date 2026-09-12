import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useGame } from '../context/GameContext'
import { gameConfig } from '../lib/games'

const usd    = (n) => n != null ? `$${Number(n).toFixed(2)}` : '—'
const fmtPnl = (n) => { if (n == null) return '—'; const v = Number(n); return `${v >= 0 ? '+$' : '-$'}${Math.abs(v).toFixed(2)}` }
const date   = (d) => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

const BOX_TYPES  = ['booster_box', 'prerelease_kit', 'single_booster', 'bundle', 'other']
const CONDITIONS = ['near_mint', 'lightly_played', 'moderately_played', 'heavily_played', 'damaged']

const BLANK = { name: '', set_name: '', box_type: 'booster_box', purchase_price: '', pack_count: '36', pack_msrp: '5', purchased_at: '', seller: '', notes: '' }

const PULL_BLANK = {
  mode:             'search',   // 'search' | 'new'
  cardId:           null,
  cardName:         '',
  tcgplayer_market: null,
  rarity:           '',
  condition:        'near_mint',
  foil:             false,
  setName:          '',
  packId:           '',
  newPackNumber:    '',
  quantity:         1,
  skipInventory:    false,
}

export default function Boxes() {
  const { activeGame } = useGame()
  const config = gameConfig(activeGame.slug)
  const [boxes,        setBoxes]        = useState([])
  const [loading,      setLoading]      = useState(true)
  const [modal,        setModal]        = useState(false)
  const [form,         setForm]         = useState(BLANK)
  const [saving,       setSaving]       = useState(false)
  const [selected,     setSelected]     = useState(null)
  const [boxCards,     setBoxCards]     = useState([])
  const [cardsLoading, setCardsLoading] = useState(false)

  // Pull modal
  const [pullModal,    setPullModal]    = useState(false)
  const [pullForm,     setPullForm]     = useState(PULL_BLANK)
  const [pullItems,    setPullItems]    = useState([])   // staged cards
  const [boxPacks,     setBoxPacks]     = useState([])
  const [existingPackCards, setExistingPackCards] = useState([])   // cards already logged in selected pack
  const [cardResults,  setCardResults]  = useState([])
  const [cardSearch,   setCardSearch]   = useState('')
  const [searchOpen,   setSearchOpen]   = useState(false)
  const [pullSaving,   setPullSaving]   = useState(false)
  const searchRef       = useRef(null)
  const justSelectedRef = useRef(false)

  const [page, setPage] = useState(0)
  const BOX_PAGE_SIZE = 20

  async function load() {
    setLoading(true)
    const { data } = await supabase
      .from('v_box_pnl')
      .select('*')
      .eq('game_id', activeGame.id)
      .order('purchased_at', { ascending: false })
    setBoxes(data ?? [])
    setLoading(false)
  }

  async function loadBoxCards(boxId) {
    setCardsLoading(true)
    const { data: packs } = await supabase.from('packs').select('id').eq('box_id', boxId)
    const packIds = (packs ?? []).map(p => p.id)
    if (!packIds.length) { setBoxCards([]); setCardsLoading(false); return }

    const { data: packCards } = await supabase
      .from('pack_cards')
      .select('quantity, pack_id, packs ( pack_number ), cards ( id, name, rarity, condition, foil, cost_basis, tcgplayer_id )')
      .in('pack_id', packIds)

    const cardIds = (packCards ?? []).map(r => r.cards?.id).filter(Boolean)
    let prices = []
    if (cardIds.length) {
      const { data: priceData } = await supabase
        .from('v_latest_prices')
        .select('card_id, tcgplayer_market, ebay_sold_avg')
        .in('card_id', cardIds)
      prices = priceData ?? []
    }
    const priceMap = Object.fromEntries(prices.map(p => [p.card_id, p]))
    setBoxCards((packCards ?? []).map(row => ({
      ...row,
      pack_number: row.packs?.pack_number ?? null,
      price: priceMap[row.cards?.id] ?? null,
    })))
    setCardsLoading(false)
  }

  async function loadBoxPacks(boxId) {
    const { data } = await supabase
      .from('packs')
      .select('id, pack_number')
      .eq('box_id', boxId)
      .order('pack_number', { ascending: true })
    setBoxPacks(data ?? [])
  }

  async function loadExistingPackCards(packId) {
    if (!packId || packId === 'new') { setExistingPackCards([]); return }
    const { data } = await supabase
      .from('pack_cards')
      .select('card_id, quantity, cards ( id, name, rarity, foil, condition )')
      .eq('pack_id', packId)
    setExistingPackCards((data ?? []).sort((a, b) => (a.cards?.name ?? '').localeCompare(b.cards?.name ?? '')))
  }

  useEffect(() => { load() }, [activeGame.id])
  useEffect(() => {
    if (selected) { loadBoxCards(selected); loadBoxPacks(selected) }
    else { setBoxCards([]); setBoxPacks([]) }
  }, [selected])
  useEffect(() => { loadExistingPackCards(pullForm.packId) }, [pullForm.packId])

  // Card search autocomplete
  useEffect(() => {
    if (!cardSearch.trim()) { setCardResults([]); return }
    if (justSelectedRef.current) { justSelectedRef.current = false; return }
    const t = setTimeout(async () => {
      const { data: cardData } = await supabase
        .from('cards')
        .select('id, name, rarity, set_name, foil')
        .eq('game_id', activeGame.id)
        .ilike('name', `%${cardSearch.trim()}%`)
        .order('name')
        .limit(8)
      if (cardData?.length) {
        const { data: priceData } = await supabase
          .from('v_latest_prices')
          .select('card_id, tcgplayer_market')
          .in('card_id', cardData.map(c => c.id))
        const priceMap = new Map((priceData ?? []).map(p => [p.card_id, p.tcgplayer_market]))
        setCardResults(cardData.map(c => ({ ...c, tcgplayer_market: priceMap.get(c.id) ?? null })))
      } else {
        setCardResults([])
      }
      setSearchOpen(true)
    }, 200)
    return () => clearTimeout(t)
  }, [cardSearch])

  // Close card search dropdown on outside click
  useEffect(() => {
    function handler(e) {
      if (searchRef.current && !searchRef.current.contains(e.target)) setSearchOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const pnlBoxes   = boxes.filter(b => (b.distinct_cards_pulled ?? 0) > 0)
  const totalCost  = pnlBoxes.reduce((s, b) => s + Number(b.purchase_price || 0), 0)
  const totalValue = pnlBoxes.reduce((s, b) => s + Number(b.cards_market_value || 0), 0)
  const totalPnl   = totalValue - totalCost
  const totalSpent = boxes.reduce((s, b) => s + Number(b.purchase_price || 0), 0)

  const totalPages   = Math.ceil(boxes.length / BOX_PAGE_SIZE)
  const safePage     = Math.min(page, Math.max(0, totalPages - 1))
  const pagedBoxes   = boxes.slice(safePage * BOX_PAGE_SIZE, (safePage + 1) * BOX_PAGE_SIZE)

  const selectedBox = boxes.find(b => b.id === selected)
  const f = (field) => (e) => setForm(prev => ({ ...prev, [field]: e.target.value }))
  const pf = (field, val) => setPullForm(prev => ({ ...prev, [field]: val !== undefined ? val : prev[field] }))

  async function save() {
    setSaving(true)
    const { error } = await supabase.from('boxes').insert({
      name:           form.name?.trim() || null,
      set_name:       form.set_name,
      box_type:       form.box_type,
      purchase_price: Number(form.purchase_price),
      pack_count:     parseInt(form.pack_count) || 36,
      pack_msrp:      parseFloat(form.pack_msrp) || 5,
      purchased_at:   form.purchased_at ? new Date(form.purchased_at).toISOString() : new Date().toISOString(),
      seller:         form.seller || null,
      notes:          form.notes || null,
      game_id:        activeGame.id,
    })
    setSaving(false)
    if (error) { alert(`Save failed: ${error.message}`); return }
    setModal(false)
    setForm(BLANK)
    load()
  }

  async function markOpened(boxId) {
    await supabase.from('boxes').update({ opened_at: new Date().toISOString() }).eq('id', boxId)
    load()
  }

  function addCardToPull() {
    if (pullForm.mode === 'search' && !pullForm.cardId) return
    if (pullForm.mode === 'new' && !pullForm.cardName.trim()) return
    setPullItems(prev => [...prev, {
      cardId:           pullForm.cardId,
      cardName:         pullForm.cardName,
      tcgplayer_market: pullForm.tcgplayer_market,
      mode:             pullForm.mode,
      rarity:           pullForm.rarity,
      condition:        pullForm.condition,
      foil:             pullForm.foil,
      setName:          pullForm.setName,
      quantity:         Number(pullForm.quantity) || 1,
    }])
    setCardSearch('')
    setCardResults([])
    setPullForm(prev => ({ ...PULL_BLANK, rarity: config.defaultRarity, setName: config.defaultSet, packId: prev.packId, newPackNumber: prev.newPackNumber }))
  }

  function removeFromPull(index) {
    setPullItems(prev => prev.filter((_, i) => i !== index))
  }

  async function savePull() {
    if (!selected) return
    if (pullItems.length === 0) { alert('Add at least one card.'); return }
    setPullSaving(true)

    try {
      // Logging a pull means the box has been opened -- set opened_at if it isn't
      // already (guarded so it never clobbers an explicitly-set date). Previously
      // this only happened via a separate "Mark opened" button, which a box could
      // never show again once packs_opened > 0 -- see the Box row render below.
      await supabase.from('boxes').update({ opened_at: new Date().toISOString() }).eq('id', selected).is('opened_at', null)

      // 1. Resolve pack ID once for all cards
      let packId = pullForm.packId === 'new' ? null : pullForm.packId
      if (pullForm.packId === 'new') {
        const packNum = parseInt(pullForm.newPackNumber)
        if (!packNum) { alert('Enter a pack number.'); setPullSaving(false); return }
        const { data: newPack, error: packErr } = await supabase
          .from('packs')
          .insert({ box_id: selected, pack_number: packNum, opened_at: new Date().toISOString() })
          .select('id')
          .single()
        if (packErr) { alert(`Pack creation failed: ${packErr.message}`); setPullSaving(false); return }
        packId = newPack.id
      }
      if (!packId) { alert('Select or create a pack first.'); setPullSaving(false); return }

      // 2. Save each card. cards.quantity_owned is maintained by the
      // trg_sync_quantity_owned trigger as SUM(pack_cards.quantity) WHERE
      // counts_inventory, so we only ever write pack_cards here -- the trigger
      // takes care of inventory (and correctly ignores skipInventory pulls).
      for (const item of pullItems) {
        let cardId = item.cardId
        const qty  = item.quantity

        if (item.mode === 'new') {
          const { data: newCard, error: cardErr } = await supabase
            .from('cards')
            .insert({ name: item.cardName.trim(), set_name: item.setName, rarity: item.rarity, condition: item.condition, foil: item.foil, game_id: activeGame.id })
            .select('id').single()
          if (cardErr) { alert(`Card creation failed: ${cardErr.message}`); setPullSaving(false); return }
          cardId = newCard.id
        }

        // A card already logged in this pack merges additively rather than
        // being overwritten -- otherwise re-adding a card via search (instead
        // of editing its row in "Cards already in this pack") silently lost
        // whatever was logged for it previously.
        const { data: existingPc, error: pcFetchErr } = await supabase
          .from('pack_cards').select('quantity').eq('pack_id', packId).eq('card_id', cardId).maybeSingle()
        if (pcFetchErr) { alert(`Could not check existing pack card: ${pcFetchErr.message}`); setPullSaving(false); return }

        const { error: pcErr } = await supabase.from('pack_cards')
          .upsert({ pack_id: packId, card_id: cardId, quantity: (existingPc?.quantity ?? 0) + qty, counts_inventory: !pullForm.skipInventory }, { onConflict: 'pack_id,card_id', ignoreDuplicates: false })
        if (pcErr) { alert(`Failed to log pull: ${pcErr.message}`); setPullSaving(false); return }
      }

      setPullModal(false)
      setPullForm(PULL_BLANK)
      setPullItems([])
      setCardSearch('')
      setCardResults([])
      loadBoxCards(selected)
      loadBoxPacks(selected)
      load()
    } catch (e) {
      alert(`Unexpected error: ${e.message}`)
    }
    setPullSaving(false)
  }

  function openPullModal() {
    setPullForm({ ...PULL_BLANK, rarity: config.defaultRarity, setName: config.defaultSet, packId: boxPacks.length === 1 ? boxPacks[0].id : '' })
    setPullItems([])
    setExistingPackCards([])
    setCardSearch('')
    setCardResults([])
    setSearchOpen(false)
    setPullModal(true)
  }

  async function removeExistingPackCard(row, askConfirm = true) {
    if (askConfirm && !confirm(`Remove ${row.cards?.name ?? 'this card'} (×${row.quantity}) from this pack and inventory?`)) return
    const packId = pullForm.packId
    try {
      const { data: existing, error: fetchErr } = await supabase.from('cards').select('quantity_owned').eq('id', row.card_id).single()
      if (fetchErr) { alert(`Could not fetch card: ${fetchErr.message}`); return }
      const newOwned = Math.max(0, (existing.quantity_owned ?? 0) - row.quantity)
      const { error: updErr } = await supabase.from('cards').update({ quantity_owned: newOwned }).eq('id', row.card_id)
      if (updErr) { alert(`Inventory update failed: ${updErr.message}`); return }
      const { error: delErr } = await supabase.from('pack_cards').delete().eq('pack_id', packId).eq('card_id', row.card_id)
      if (delErr) { alert(`Failed to remove card from pack: ${delErr.message}`); return }
      loadExistingPackCards(packId)
      loadBoxCards(selected)
      loadBoxPacks(selected)
      load()
    } catch (e) {
      alert(`Unexpected error: ${e.message}`)
    }
  }

  async function updateExistingPackCardQty(row, newQtyRaw) {
    const newQty = parseInt(newQtyRaw)
    if (Number.isNaN(newQty) || newQty === row.quantity) return
    if (newQty <= 0) { await removeExistingPackCard(row, false); return }
    const delta = newQty - row.quantity
    try {
      const { data: existing, error: fetchErr } = await supabase.from('cards').select('quantity_owned').eq('id', row.card_id).single()
      if (fetchErr) { alert(`Could not fetch card: ${fetchErr.message}`); return }
      const newOwned = Math.max(0, (existing.quantity_owned ?? 0) + delta)
      const { error: updErr } = await supabase.from('cards').update({ quantity_owned: newOwned }).eq('id', row.card_id)
      if (updErr) { alert(`Inventory update failed: ${updErr.message}`); return }
      const { error: pcErr } = await supabase.from('pack_cards').update({ quantity: newQty }).eq('pack_id', pullForm.packId).eq('card_id', row.card_id)
      if (pcErr) { alert(`Failed to update pack card: ${pcErr.message}`); return }
      loadExistingPackCards(pullForm.packId)
      loadBoxCards(selected)
      load()
    } catch (e) {
      alert(`Unexpected error: ${e.message}`)
    }
  }

  function selectCard(card) {
    justSelectedRef.current = true
    setPullForm(prev => ({ ...prev, mode: 'search', cardId: card.id, cardName: card.name, tcgplayer_market: card.tcgplayer_market ?? null }))
    setCardSearch(card.name)
    setSearchOpen(false)
  }

  function switchToNew() {
    setPullForm(prev => ({ ...prev, mode: 'new', cardId: null, cardName: cardSearch }))
    setSearchOpen(false)
  }

  return (
    <div className="page">
      <div className="page-header flex-between">
        <div>
          <h1 className="page-title">Boxes & P&L</h1>
          <p className="page-subtitle">{boxes.length} boxes tracked</p>
        </div>
        <button className="btn btn-primary" onClick={() => { setForm({ ...BLANK, set_name: config.defaultSet }); setModal(true) }}>+ Add box</button>
      </div>

      {/* Summary metrics */}
      <div className="metrics-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="metric-card">
          <div className="metric-label">Total spent</div>
          <div className="metric-value">{usd(totalSpent)}</div>
          <div className="metric-sub">{boxes.length} boxes, purchase price</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Total invested</div>
          <div className="metric-value">{usd(totalCost)}</div>
          <div className="metric-sub">{pnlBoxes.length} of {boxes.length} boxes with cards</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Cards market value</div>
          <div className="metric-value gold">{usd(totalValue)}</div>
          <div className="metric-sub">at current prices</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Gross P&L</div>
          <div className="metric-value" style={{ color: totalPnl >= 0 ? 'var(--success)' : 'var(--danger)' }}>
            {fmtPnl(totalPnl)}
          </div>
          <div className="metric-sub">unrealized</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: selected ? '380px 1fr' : '1fr', gap: 16 }}>

        {/* Boxes list */}
        <div>
          {loading ? (
            <div className="loading">Loading boxes…</div>
          ) : boxes.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">📦</div>
              No boxes yet — add one to start tracking P&L.
            </div>
          ) : (
            <div className="panel">
              <table className="data-table" style={{ tableLayout: 'fixed' }}>
                <colgroup>
                  {selected ? (
                    <>
                      <col style={{ width: '42%' }} />
                      <col style={{ width: '18%' }} />
                      <col style={{ width: '20%' }} />
                      <col style={{ width: '20%' }} />
                    </>
                  ) : (
                    <>
                      <col style={{ width: '28%' }} />
                      <col style={{ width: '14%' }} />
                      <col style={{ width: '13%' }} />
                      <col style={{ width: '13%' }} />
                      <col style={{ width: '13%' }} />
                      <col style={{ width: '19%' }} />
                    </>
                  )}
                </colgroup>
                <thead>
                  <tr>
                    <th>Box</th>
                    {!selected && <th style={{ whiteSpace: 'nowrap' }}>Type</th>}
                    <th className="text-right" style={{ whiteSpace: 'nowrap' }}>Cost</th>
                    {!selected && <th className="text-right" style={{ whiteSpace: 'nowrap' }}>Card value</th>}
                    <th className="text-right" style={{ whiteSpace: 'nowrap' }}>P&L</th>
                    <th className="text-right" style={{ whiteSpace: 'nowrap' }}>Cards</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedBoxes.map(box => (
                    <tr
                      key={box.id}
                      style={{
                        cursor: 'pointer',
                        background: selected === box.id ? 'var(--bg-hover)' : undefined,
                        borderLeft: selected === box.id ? '2px solid var(--gold)' : '2px solid transparent',
                      }}
                      onClick={() => setSelected(selected === box.id ? null : box.id)}
                    >
                      <td>
                        <div className="name-cell" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {box.name ?? box.set_name}
                        </div>
                        <div className="set-cell">{selected ? box.box_type?.replace(/_/g, ' ') : date(box.purchased_at)}</div>
                      </td>
                      {!selected && (
                        <td className="text-muted" style={{ fontSize: 12 }}>
                          {box.box_type?.replace(/_/g, ' ')}
                        </td>
                      )}
                      <td className="text-right">{usd(box.purchase_price)}</td>
                      {!selected && <td className="text-right text-gold">{usd(box.cards_market_value)}</td>}
                      <td className="text-right">
                        <span style={{ color: Number(box.gross_pnl) >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                          {fmtPnl(box.gross_pnl)}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
                          {!box.opened_at ? (
                            <button
                              className="btn btn-ghost btn-sm"
                              style={{ whiteSpace: 'nowrap', fontSize: 11 }}
                              onClick={e => { e.stopPropagation(); markOpened(box.id) }}
                            >
                              Mark opened
                            </button>
                          ) : (
                            <>
                              <span className="badge badge-ok" style={{ fontSize: 10 }}>Opened</span>
                              <span className="text-muted" style={{ fontSize: 11 }}>{box.distinct_cards_pulled ?? 0} cards</span>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {totalPages > 1 && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => setPage(0)} disabled={safePage === 0}>«</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0}>‹ Prev</button>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    Page {safePage + 1} of {totalPages} · {boxes.length} boxes
                  </span>
                  <button className="btn btn-ghost btn-sm" onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={safePage === totalPages - 1}>Next ›</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setPage(totalPages - 1)} disabled={safePage === totalPages - 1}>»</button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Drill-down panel */}
        {selected && (
          <div>
            <div className="panel">
              <div className="panel-header">
                <div>
                  <div className="panel-title">{selectedBox?.name ?? selectedBox?.set_name} — Cards pulled</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {selectedBox?.box_type?.replace(/_/g, ' ')} · {usd(selectedBox?.purchase_price)} cost
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button className="btn btn-primary btn-sm" onClick={openPullModal}>+ Log pull</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setSelected(null)}>✕</button>
                </div>
              </div>

              {/* Box P&L summary */}
              {(() => {
                const trueValue = boxCards.reduce((s, r) => {
                  const p = r.price?.tcgplayer_market ?? 0
                  return p >= 2 ? s + p * r.quantity : s
                }, 0)
                return (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr', borderBottom: '1px solid var(--border)' }}>
                    {(() => {
                      const truePnl = trueValue - (selectedBox?.purchase_price ?? 0)
                      return [
                        ['Cost',           usd(selectedBox?.purchase_price),    null],
                        ['Card value',     usd(selectedBox?.cards_market_value), 'var(--gold-light)'],
                        ['True value ≥$2', usd(trueValue),                      'var(--gold)'],
                        ['P&L',            fmtPnl(selectedBox?.gross_pnl),       Number(selectedBox?.gross_pnl) >= 0 ? 'var(--success)' : 'var(--danger)'],
                        ['True P&L',       fmtPnl(truePnl),                      truePnl >= 0 ? 'var(--success)' : 'var(--danger)'],
                      ]
                    })().map(([label, val, color]) => (
                      <div key={label} style={{ padding: '12px 16px', borderRight: '1px solid var(--border)' }}>
                        <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
                        <div className="metric-value" style={{ fontSize: 18, color: color ?? 'var(--text-primary)' }}>{val}</div>
                      </div>
                    ))}
                  </div>
                )
              })()}

              {/* Cards table */}
              {cardsLoading ? (
                <div className="loading" style={{ padding: 24 }}>Loading cards…</div>
              ) : boxCards.length === 0 ? (
                <div className="empty-state" style={{ padding: 32 }}>
                  <div className="empty-state-icon">🃏</div>
                  No cards logged yet.
                  <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                    Use "+ Log pull" above to add cards one by one, or the Bulk Import page for a full sheet.
                  </div>
                </div>
              ) : (
                <table className="data-table" style={{ tableLayout: 'fixed' }}>
                  <colgroup>
                    <col style={{ width: '35%' }} />
                    <col style={{ width: '9%' }} />
                    <col style={{ width: '18%' }} />
                    <col style={{ width: '7%' }} />
                    <col style={{ width: '12%' }} />
                    <col style={{ width: '10%' }} />
                    <col style={{ width: '9%' }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Card</th>
                      <th>Pack</th>
                      <th>Rarity</th>
                      <th className="text-right">Qty</th>
                      <th className="text-right">Cost</th>
                      <th className="text-right">TCGPlayer</th>
                      <th className="text-right">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {boxCards
                      .sort((a, b) => (a.pack_number ?? 0) - (b.pack_number ?? 0))
                      .map((row, i) => {
                        const card     = row.cards
                        const mktPrice = row.price?.tcgplayer_market
                        const value    = mktPrice ? mktPrice * row.quantity : null
                        const costBasis = card?.cost_basis != null ? Number(card.cost_basis) * row.quantity : null
                        return (
                          <tr key={i} style={card?.foil ? { background: 'rgba(201,168,76,0.07)', borderLeft: '2px solid rgba(201,168,76,0.4)' } : undefined}>
                            <td className="name-cell" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{card?.name}{card?.foil ? ' ✦' : ''}</td>
                            <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>#{row.pack_number ?? '—'}</td>
                            <td><span className={`badge badge-${card?.rarity}`}>{card?.rarity}</span></td>
                            <td className="text-right">{row.quantity}</td>
                            <td className="text-right text-muted">{costBasis != null ? usd(costBasis) : '—'}</td>
                            <td className="text-right">{usd(mktPrice)}</td>
                            <td className="text-right text-gold">{usd(value)}</td>
                          </tr>
                        )
                      })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={6} style={{ padding: '10px 14px 4px', fontSize: 11, color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}>
                        Total card value
                      </td>
                      <td className="text-right text-gold" style={{ padding: '10px 14px 4px', fontWeight: 500, borderTop: '1px solid var(--border)' }}>
                        {usd(boxCards.reduce((s, r) => s + (r.price?.tcgplayer_market ?? 0) * r.quantity, 0))}
                      </td>
                    </tr>
                    <tr>
                      <td colSpan={6} style={{ padding: '4px 14px 10px', fontSize: 11, color: 'var(--text-muted)' }}>
                        True value <span style={{ color: 'var(--gold)', opacity: 0.7 }}>(≥$2 cards only)</span>
                      </td>
                      <td className="text-right" style={{ padding: '4px 14px 10px', fontWeight: 500, color: 'var(--gold)' }}>
                        {usd(boxCards.reduce((s, r) => {
                          const p = r.price?.tcgplayer_market ?? 0
                          return p >= 2 ? s + p * r.quantity : s
                        }, 0))}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Add box modal ───────────────────────────────────────────────────── */}
      {modal && (
        <div className="modal-overlay" onClick={() => setModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Add box</span>
              <button className="btn btn-ghost btn-sm" onClick={() => setModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Box name</label>
                  <input className="form-input" value={form.name ?? ''} onChange={f('name')} placeholder="e.g. Gothic Box 1" />
                </div>
                <div className="form-group">
                  <label className="form-label">Set</label>
                  <select className="form-select" value={form.set_name} onChange={f('set_name')}>
                    {config.sets.map(s => <option key={s}>{s}</option>)}
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Box type</label>
                  <select className="form-select" value={form.box_type} onChange={f('box_type')}>
                    {BOX_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Purchase price ($) *</label>
                  <input className="form-input" type="number" step="0.01" value={form.purchase_price} onChange={f('purchase_price')} placeholder="e.g. 180.00" />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Pack count</label>
                  <input className="form-input" type="number" value={form.pack_count} onChange={f('pack_count')} placeholder="36" />
                </div>
                <div className="form-group">
                  <label className="form-label">Pack MSRP ($)</label>
                  <input className="form-input" type="number" step="0.01" value={form.pack_msrp} onChange={f('pack_msrp')} placeholder="5.00" />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Purchase date</label>
                  <input className="form-input" type="date" value={form.purchased_at} onChange={f('purchased_at')} />
                </div>
                <div className="form-group">
                  <label className="form-label">Seller / source</label>
                  <input className="form-input" value={form.seller} onChange={f('seller')} placeholder="e.g. local game store" />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Notes</label>
                <textarea className="form-textarea" value={form.notes} onChange={f('notes')} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={save} disabled={!form.purchase_price || saving}>
                {saving ? 'Saving…' : 'Add box'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Log pull modal ──────────────────────────────────────────────────── */}
      {pullModal && (
        <div className="modal-overlay" onClick={() => setPullModal(false)}>
          <div className="modal" style={{ maxWidth: 500 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Log pull — {selectedBox?.name ?? selectedBox?.set_name}</span>
              <button className="btn btn-ghost btn-sm" onClick={() => setPullModal(false)}>✕</button>
            </div>
            <div className="modal-body">

              {/* ── Pack selection (shared for all cards) ── */}
              <div className="form-row" style={{ marginBottom: 16 }}>
                <div className="form-group">
                  <label className="form-label">Pack *</label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <select className="form-select" value={pullForm.packId} onChange={e => pf('packId', e.target.value)}>
                      <option value="">Select pack…</option>
                      {boxPacks.map(p => <option key={p.id} value={p.id}>Pack #{p.pack_number}</option>)}
                    </select>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ whiteSpace: 'nowrap' }}
                      onClick={() => {
                        const nextNum = boxPacks.length > 0
                          ? Math.max(...boxPacks.map(p => p.pack_number)) + 1
                          : 1
                        setPullForm(prev => ({ ...prev, packId: 'new', newPackNumber: String(nextNum) }))
                      }}
                    >
                      + New Pack
                    </button>
                  </div>
                </div>
                {pullForm.packId === 'new' && (
                  <div className="form-group">
                    <label className="form-label">Pack number</label>
                    <input className="form-input" type="number" min="1" value={pullForm.newPackNumber} onChange={e => pf('newPackNumber', e.target.value)} placeholder="e.g. 1" />
                  </div>
                )}
              </div>

              {/* ── Cards already in the selected pack ── */}
              {pullForm.packId && pullForm.packId !== 'new' && (
                <div style={{ background: 'var(--bg-void)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '8px 12px', borderBottom: '1px solid var(--border)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                    Cards already in this pack
                  </div>
                  {existingPackCards.length === 0 ? (
                    <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-muted)' }}>No cards logged for this pack yet.</div>
                  ) : existingPackCards.map(row => (
                    <div key={row.card_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                      <span className={`badge badge-${row.cards?.rarity}`} style={{ fontSize: 10 }}>{row.cards?.rarity}</span>
                      <span style={{ flex: 1, color: 'var(--text-primary)' }}>{row.cards?.name}{row.cards?.foil ? ' ✦' : ''}</span>
                      <input
                        type="number"
                        min="0"
                        defaultValue={row.quantity}
                        onBlur={e => updateExistingPackCardQty(row, e.target.value)}
                        style={{ width: 48, background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)', fontSize: 12, textAlign: 'center', padding: '2px 4px' }}
                      />
                      <button
                        onClick={() => removeExistingPackCard(row)}
                        title="Remove from pack and inventory"
                        style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' }}
                      >×</button>
                    </div>
                  ))}
                </div>
              )}

              {/* ── Card picker ── */}
              <div style={{ background: 'var(--bg-void)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px', marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: 'var(--gold)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Add card</div>

                <div className="form-group" ref={searchRef} style={{ position: 'relative', marginBottom: 8 }}>
                  <input
                    className="form-input"
                    value={cardSearch}
                    onChange={e => {
                      setCardSearch(e.target.value)
                      setPullForm(prev => ({ ...prev, cardId: null, cardName: e.target.value, mode: 'search' }))
                      if (!e.target.value.trim()) setSearchOpen(false)
                    }}
                    onFocus={() => cardResults.length > 0 && setSearchOpen(true)}
                    placeholder="Search by card name…"
                    autoComplete="off"
                  />
                  {searchOpen && (cardResults.length > 0 || cardSearch.trim()) && (
                    <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 300, background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.5)', overflow: 'hidden' }}>
                      {cardResults.map(card => (
                        <div key={card.id} onMouseDown={() => selectCard(card)}
                          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', cursor: 'pointer' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.04)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                          <span className={`badge badge-${card.rarity}`} style={{ fontSize: 10 }}>{card.rarity}</span>
                          <span style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)' }}>{card.name}{card.foil ? ' ✦' : ''}</span>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{card.set_name}</span>
                          {card.tcgplayer_market != null && (
                            <span style={{ fontSize: 12, color: 'var(--gold)', fontWeight: 500 }}>{usd(card.tcgplayer_market)}</span>
                          )}
                        </div>
                      ))}
                      {cardSearch.trim() && (
                        <div onMouseDown={switchToNew}
                          style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, color: 'var(--gold)', borderTop: cardResults.length ? '1px solid var(--border)' : 'none' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'rgba(201,168,76,0.06)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                          + Create new card "{cardSearch.trim()}"
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {pullForm.mode === 'new' && (
                  <div style={{ marginBottom: 8 }}>
                    <div className="form-row">
                      <div className="form-group">
                        <label className="form-label">Rarity *</label>
                        <select className="form-select" value={pullForm.rarity} onChange={e => pf('rarity', e.target.value)}>
                          {config.rarities.map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                      </div>
                      <div className="form-group">
                        <label className="form-label">Set</label>
                        <select className="form-select" value={pullForm.setName} onChange={e => pf('setName', e.target.value)}>
                          {config.sets.map(s => <option key={s}>{s}</option>)}
                        </select>
                      </div>
                    </div>
                    <div className="form-row">
                      <div className="form-group">
                        <label className="form-label">Condition</label>
                        <select className="form-select" value={pullForm.condition} onChange={e => pf('condition', e.target.value)}>
                          {CONDITIONS.map(c => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
                        </select>
                      </div>
                      <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 2 }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)' }}>
                          <input type="checkbox" checked={pullForm.foil} onChange={e => pf('foil', e.target.checked)} style={{ width: 15, height: 15, accentColor: 'var(--gold)' }} />
                          Foil ✦
                        </label>
                      </div>
                    </div>
                  </div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
                    <label className="form-label" style={{ margin: 0, whiteSpace: 'nowrap' }}>Qty</label>
                    <input className="form-input" type="number" min="1" value={pullForm.quantity} onChange={e => pf('quantity', e.target.value)} style={{ width: 64 }} />
                  </div>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={addCardToPull}
                    disabled={(!pullForm.cardId && pullForm.mode !== 'new') || (pullForm.mode === 'new' && !pullForm.cardName.trim())}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    + Add card
                  </button>
                </div>
              </div>

              {/* ── Staged cards list ── */}
              {pullItems.length > 0 && (
                <div style={{ background: 'var(--bg-void)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '8px 12px', borderBottom: '1px solid var(--border)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                    {pullItems.length} card{pullItems.length !== 1 ? 's' : ''} to log
                  </div>
                  {pullItems.map((item, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderBottom: i < pullItems.length - 1 ? '1px solid var(--border)' : 'none', fontSize: 13 }}>
                      {item.mode === 'new' && <span className={`badge badge-${item.rarity}`} style={{ fontSize: 10 }}>{item.rarity}</span>}
                      <span style={{ flex: 1, color: 'var(--text-primary)' }}>{item.cardName}{item.foil ? ' ✦' : ''}</span>
                      {item.quantity > 1 && <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>×{item.quantity}</span>}
                      {item.tcgplayer_market != null && <span style={{ color: 'var(--gold)', fontSize: 12, fontWeight: 500 }}>{usd(item.tcgplayer_market)}</span>}
                      <button onClick={() => removeFromPull(i)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' }}>×</button>
                    </div>
                  ))}
                </div>
              )}

            </div>
            <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12, color: 'var(--text-secondary)' }} title="Log these cards to the pack for video/box tracking, but don't add them to sellable inventory (e.g. they already sold before filming).">
                <input type="checkbox" checked={pullForm.skipInventory} onChange={e => pf('skipInventory', e.target.checked)} style={{ width: 15, height: 15, accentColor: 'var(--gold)' }} />
                Don't update inventory
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={() => setPullModal(false)}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={savePull}
                disabled={pullSaving || pullItems.length === 0 || !pullForm.packId || (pullForm.packId === 'new' && !pullForm.newPackNumber)}
              >
                {pullSaving ? 'Saving…' : `Log ${pullItems.length || ''} pull${pullItems.length !== 1 ? 's' : ''}`}
              </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
