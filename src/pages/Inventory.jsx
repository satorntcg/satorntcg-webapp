import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useGame } from '../context/GameContext'
import { gameConfig } from '../lib/games'

const usd = (n) => n != null ? `$${Number(n).toFixed(2)}` : '—'

const CONDITIONS = ['near_mint', 'lightly_played', 'moderately_played', 'heavily_played', 'damaged']

const BLANK = {
  name: '', set_name: '', set_code: '', rarity: '',
  condition: 'near_mint', foil: false, quantity_owned: 1,
  cost_basis: '', image_url: '', tcgplayer_id: '', notes: '', card_type: '',
}

const CONDITION_MAP = {
  near_mint:         (foil) => foil ? 'Near Mint Foil'         : 'Near Mint',
  lightly_played:    (foil) => foil ? 'Lightly Played Foil'    : 'Lightly Played',
  moderately_played: (foil) => foil ? 'Moderately Played Foil' : 'Moderately Played',
  heavily_played:    (foil) => foil ? 'Heavily Played Foil'    : 'Heavily Played',
  damaged:           (foil) => foil ? 'Damaged Foil'           : 'Damaged',
}

function exportInventoryCSV(cards) {
  const escape = v => {
    const s = String(v ?? '')
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s
  }
  const headers = ['Name', 'Set', 'Rarity', 'Condition', 'Foil', 'Qty Owned', 'Qty Listed', 'Cost Basis', 'TCG Market', 'Market Value', 'Unrealised P&L', 'Notes']
  const rows = cards.map(c => [
    c.name ?? '',
    c.set_name ?? '',
    c.rarity ?? '',
    c.condition?.replace(/_/g, ' ') ?? '',
    c.foil ? 'Yes' : 'No',
    c.quantity_owned ?? 0,
    c.quantity_listed ?? 0,
    c.cost_basis != null ? Number(c.cost_basis).toFixed(2) : '',
    c.tcgplayer_market != null ? Number(c.tcgplayer_market).toFixed(2) : '',
    c.market_value != null ? Number(c.market_value).toFixed(2) : '',
    c.unrealized_pnl != null ? Number(c.unrealized_pnl).toFixed(2) : '',
    c.notes ?? '',
  ])
  const csv = [headers, ...rows].map(r => r.map(escape).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `inventory-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function exportTCGPlayerCSV(cards, productLine) {
  const withId  = cards.filter(c => c.tcgplayer_id)
  const missing = cards.filter(c => !c.tcgplayer_id)

  const headers = [
    'TCGplayer Id',
    'Product Line',
    'Set Name',
    'Product Name',
    'Title',
    'Number',
    'Rarity',
    'Condition',
    'TCG Market Price',
    'TCG Direct Low',
    'TCG Low w/ Shipping',
    'TCG Low Price',
    'Total Quantity',
    'Add to Quantity',
    'TCG Marketplace Price',
  ]

  const rows = withId.map(c => {
    const condLabel = (CONDITION_MAP[c.condition] ?? (() => c.condition ?? ''))(Boolean(c.foil))
    const price = c.tcgplayer_market ? Number(c.tcgplayer_market).toFixed(2) : '0.01'
    return [
      c.tcgplayer_id,
      productLine,
      c.set_name ?? '',
      c.name ?? '',
      '',
      '',
      c.rarity ?? '',
      condLabel,
      price,
      '',
      '',
      '',
      c.quantity_owned ?? 0,
      c.quantity_owned ?? 0,
      price,
    ]
  })

  const escape = v => {
    const s = String(v ?? '')
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s
  }

  const csv = [headers, ...rows].map(r => r.map(escape).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `tcgplayer-import-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)

  return {
    exported: withId.length,
    skipped: missing.length,
    skippedNames: missing.map(c => c.name),
  }
}

export default function Inventory() {
  const navigate = useNavigate()
  const { activeGame } = useGame()
  const config = gameConfig(activeGame.slug)
  const [cards, setCards]           = useState([])
  const [loading, setLoading]       = useState(true)
  const [search, setSearch]         = useState('')
  const [modal, setModal]           = useState(null)   // null | 'add' | 'edit'
  const [form, setForm]             = useState(BLANK)
  const [saving, setSaving]         = useState(false)
  const [deleteId, setDeleteId]     = useState(null)
  const [boxes, setBoxes]           = useState([])
  const [packs, setPacks]           = useState([])
  const [selBoxId, setSelBoxId]     = useState('')
  const [selPackId, setSelPackId]   = useState('')
  const [newPackNumber, setNewPackNumber] = useState(1)
  const [inStockOnly, setInStockOnly]    = useState(false)
  const [rarityFilter, setRarityFilter]  = useState('all')
  const [setFilter,    setSetFilter]     = useState('all')
  const [foilFilter,   setFoilFilter]    = useState('all')
  const [exportResult, setExportResult]  = useState(null)
  const [provenance, setProvenance]      = useState({})
  const [expanded, setExpanded]          = useState(new Set())
  const [selectedIds, setSelectedIds]    = useState(new Set())
  const [page, setPage]                  = useState(0)
  const [sortField, setSortField]        = useState('name')
  const [sortDir, setSortDir]            = useState('asc')
  const PAGE_SIZE = 100

  async function load() {
    setLoading(true)
    // Fetch all cards in batches to bypass the 1000-row default limit
    let allCards = [], batchPage = 0
    while (true) {
      const { data } = await supabase.from('v_inventory_dashboard').select('*').eq('game_id', activeGame.id).order('name')
        .range(batchPage * 1000, (batchPage + 1) * 1000 - 1)
      allCards = [...allCards, ...(data ?? [])]
      if (!data || data.length < 1000) break
      batchPage++
    }
    const [{ data: packLinks }] = await Promise.all([
      supabase.from('pack_cards').select('card_id, quantity, packs(pack_number, pack_ref, boxes(name, set_name))'),
    ])
    setCards(allCards)

    const provMap = {}
    for (const link of (packLinks ?? [])) {
      const cid = link.card_id
      if (!provMap[cid]) provMap[cid] = []
      provMap[cid].push({
        box_name:    link.packs?.boxes?.name || link.packs?.boxes?.set_name || '—',
        pack_number: link.packs?.pack_number,
        pack_ref:    link.packs?.pack_ref,
        quantity:    link.quantity,
      })
    }
    setProvenance(provMap)
    setLoading(false)
  }

  useEffect(() => { load() }, [activeGame.id])

  async function fetchBoxes() {
    const { data } = await supabase.from('boxes').select('id, name, purchase_price, pack_count').eq('game_id', activeGame.id).order('name')
    setBoxes(data ?? [])
  }

  async function fetchPacks(boxId) {
    if (!boxId) { setPacks([]); setSelPackId(''); return }
    const { data } = await supabase.from('packs').select('id, pack_number').eq('box_id', boxId).order('pack_number')
    setPacks(data ?? [])
    setSelPackId('')
    setNewPackNumber(1)
  }

  const sets = [...new Set(cards.map(c => c.set_name).filter(Boolean))].sort()

  useEffect(() => { setPage(0) }, [search, inStockOnly, rarityFilter, setFilter, foilFilter, sortField, sortDir])

  const filtered = cards.filter(c => {
    const matchSearch = c.name?.toLowerCase().includes(search.toLowerCase()) ||
      c.set_name?.toLowerCase().includes(search.toLowerCase())
    const matchStock  = !inStockOnly || (c.quantity_owned ?? 0) > 0
    const matchRarity = rarityFilter === 'all' || c.rarity === rarityFilter
    const matchSet    = setFilter === 'all' || c.set_name === setFilter
    const matchFoil   = foilFilter === 'all' || (foilFilter === 'foil' ? c.foil : !c.foil)
    return matchSearch && matchStock && matchRarity && matchSet && matchFoil
  })

  const totalValue     = filtered.reduce((sum, c) => sum + ((c.tcgplayer_market ?? 0) * (c.quantity_owned ?? 1)), 0)
  const totalValueUnit = filtered.filter(c => (c.quantity_owned ?? 0) > 0).reduce((sum, c) => sum + (c.tcgplayer_market ?? 0), 0)
  const totalCost      = filtered.reduce((sum, c) => sum + ((c.cost_basis ?? 0) * (c.quantity_owned ?? 1)), 0)

  const SORT_ACCESSORS = {
    name:            c => c.name?.toLowerCase() ?? '',
    rarity:          c => config.rarities.indexOf(c.rarity),
    condition:       c => CONDITIONS.indexOf(c.condition),
    quantity_owned:  c => c.quantity_owned ?? 0,
    cost_basis:      c => c.cost_basis ?? -Infinity,
    tcgplayer_market: c => c.tcgplayer_market ?? -Infinity,
    ebay_sold_avg:   c => c.ebay_sold_avg ?? -Infinity,
    market_value:    c => c.market_value ?? -Infinity,
    unrealized_pnl:  c => c.unrealized_pnl ?? -Infinity,
  }

  function handleSort(field) {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDir('asc')
    }
  }

  function sortArrow(field) {
    if (sortField !== field) return null
    return <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '▲' : '▼'}</span>
  }

  const accessor = SORT_ACCESSORS[sortField] ?? SORT_ACCESSORS.name
  const sorted = [...filtered].sort((a, b) => {
    const av = accessor(a), bv = accessor(b)
    if (av < bv) return sortDir === 'asc' ? -1 : 1
    if (av > bv) return sortDir === 'asc' ? 1 : -1
    return 0
  })

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE)
  const safePage   = Math.min(page, Math.max(0, totalPages - 1))
  const paginated  = sorted.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

  function openAdd() {
    setForm({ ...BLANK, set_name: config.defaultSet, rarity: config.defaultRarity })
    setSelBoxId('')
    setSelPackId('')
    setNewPackNumber(1)
    fetchBoxes()
    setModal('add')
  }

  function openEdit(card) {
    setForm({
      ...card,
      id:           card.card_id ?? card.id,
      cost_basis:   card.cost_basis ?? '',
      image_url:    card.image_url  ?? '',
      tcgplayer_id: card.tcgplayer_id ?? '',
      notes:        card.notes ?? '',
    })
    setModal('edit')
  }

  function closeModal() { setModal(null); setForm(BLANK) }

  async function save() {
    setSaving(true)
    const payload = {
      name:           form.name?.trim(),
      set_name:       form.set_name,
      set_code:       form.set_code?.trim() || null,
      rarity:         form.rarity,
      condition:      form.condition,
      foil:           Boolean(form.foil),
      quantity_owned: parseInt(form.quantity_owned) || 0,
      image_url:      form.image_url?.trim()    || null,
      tcgplayer_id:   form.tcgplayer_id?.trim() || null,
      notes:          form.notes?.trim()         || null,
      card_type:      form.card_type             || null,
    }
    if (form.cost_basis !== '' && form.cost_basis != null) {
      payload.cost_basis = parseFloat(form.cost_basis) || null
    }

    let error
    if (modal === 'add') {
      // When linking the new card to a pack, the pack_cards insert below adds
      // its quantity to quantity_owned via trg_sync_quantity_owned -- start
      // the card at 0 so it isn't counted twice.
      const addQty = payload.quantity_owned
      const linkPack = addQty > 0 && (selPackId || selBoxId)
      const res = await supabase.from('cards').insert({ ...payload, quantity_owned: linkPack ? 0 : addQty, game_id: activeGame.id }).select('id').single()
      error = res.error
      if (!error && res.data?.id) {
        let packId = linkPack ? selPackId : null
        if (linkPack && !packId && selBoxId) {
          const { data: newPack } = await supabase
            .from('packs')
            .insert({ box_id: selBoxId, pack_number: newPackNumber })
            .select('id')
            .single()
          packId = newPack?.id
        }
        if (packId) {
          await supabase.from('pack_cards').insert({ pack_id: packId, card_id: res.data.id, quantity: addQty })
        }
      }
    } else {
      // Editing quantity_owned is a direct inventory correction -- pull history
      // in pack_cards is left alone (it still drives box P&L), and deleting
      // rows here would make trg_sync_quantity_owned subtract them a second time.
      const res = await supabase.from('cards').update(payload).eq('id', form.id)
      error = res.error
    }

    setSaving(false)

    if (error) {
      alert(`Save failed: ${error.message}`)
      return
    }

    closeModal()
    load()
  }

  async function confirmDelete() {
    await supabase.from('pack_cards').delete().eq('card_id', deleteId)
    await supabase.from('cards').delete().eq('id', deleteId)
    setDeleteId(null)
    load()
  }

  const f = (field) => (e) => setForm(prev => ({
    ...prev,
    [field]: e.target.type === 'checkbox' ? e.target.checked : e.target.value
  }))

  function toggleExpand(id) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleSelect(id) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const filteredIds = filtered.map(c => c.card_id ?? c.id)
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every(id => selectedIds.has(id))
  const someFilteredSelected = filteredIds.some(id => selectedIds.has(id))

  function toggleSelectAll() {
    if (allFilteredSelected) {
      setSelectedIds(prev => {
        const next = new Set(prev)
        filteredIds.forEach(id => next.delete(id))
        return next
      })
    } else {
      setSelectedIds(prev => {
        const next = new Set(prev)
        filteredIds.forEach(id => next.add(id))
        return next
      })
    }
  }

  const cardsToExport = selectedIds.size > 0
    ? filtered.filter(c => selectedIds.has(c.card_id ?? c.id))
    : filtered

  return (
    <div className="page">
      <div className="page-header flex-between">
        <div>
          <h1 className="page-title">Inventory</h1>
          <p className="page-subtitle">{cards.length} cards tracked</p>
        </div>
        <div className="flex gap-8" style={{ alignItems: 'center' }}>
          {selectedIds.size > 0 && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {selectedIds.size} selected
              <button
                className="btn btn-ghost btn-sm"
                style={{ marginLeft: 6, padding: '1px 6px', fontSize: 11 }}
                onClick={() => setSelectedIds(new Set())}
              >
                Clear
              </button>
            </span>
          )}
          <button
            className="btn btn-ghost"
            onClick={() => exportInventoryCSV(cardsToExport)}
            disabled={loading || filtered.length === 0}
          >
            ↓ Export CSV{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => setExportResult(exportTCGPlayerCSV(cardsToExport, config.displayName))}
            disabled={loading || filtered.length === 0}
          >
            ↓ TCGPlayer{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
          </button>
          <button className="btn btn-primary" onClick={openAdd}>+ Add card</button>
        </div>
      </div>

      {/* Search + filters */}
      <div className="mb-8" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          className="form-input"
          style={{ maxWidth: 280 }}
          placeholder="Search cards or sets…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select className="form-select" style={{ maxWidth: 150 }} value={rarityFilter} onChange={e => setRarityFilter(e.target.value)}>
          <option value="all">All Rarities</option>
          {config.rarities.map(r => <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>)}
        </select>
        <select className="form-select" style={{ maxWidth: 160 }} value={setFilter} onChange={e => setSetFilter(e.target.value)}>
          <option value="all">All Sets</option>
          {sets.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <div style={{ display: 'flex', background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 3, gap: 2 }}>
          {['all', 'non-foil', 'foil'].map(v => (
            <button key={v} onClick={() => setFoilFilter(v)} style={{
              padding: '3px 10px', fontSize: 12, border: 'none', borderRadius: 'calc(var(--radius-sm) - 2px)', cursor: 'pointer',
              background: foilFilter === v ? 'var(--gold)' : 'transparent',
              color: foilFilter === v ? 'var(--bg-void)' : 'var(--text-secondary)',
              fontWeight: foilFilter === v ? 600 : 400,
            }}>
              {v === 'all' ? 'All' : v === 'foil' ? '✦ Foil' : 'Non-Foil'}
            </button>
          ))}
        </div>
        <button
          className={`btn btn-sm ${inStockOnly ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setInStockOnly(v => !v)}
        >
          {inStockOnly ? '✓ In stock only' : 'In stock only'}
        </button>
      </div>

      {/* Running totals */}
      {!loading && (
        <div style={{ display: 'flex', gap: 24, marginBottom: 16, fontSize: 13, color: 'var(--text-muted)', flexWrap: 'wrap', alignItems: 'center' }}>
          <span>{filtered.length} card{filtered.length !== 1 ? 's' : ''}</span>
          <span>
            TCG value:{' '}
            <span className="text-gold" style={{ fontWeight: 600 }}>${totalValue.toFixed(2)}</span>
            <span style={{ color: 'var(--text-muted)', margin: '0 4px' }}>·</span>
            <span title="1× each card" style={{ color: 'var(--text-secondary)' }}>${totalValueUnit.toFixed(2)} ×1</span>
          </span>
          <span>Cost basis: <span style={{ color: 'var(--text-secondary)' }}>${totalCost.toFixed(2)}</span></span>
          <span style={{ color: totalValue - totalCost >= 0 ? 'var(--success)' : 'var(--danger)' }}>
            Unrealised P&L: {totalValue - totalCost >= 0 ? '+' : ''}${(totalValue - totalCost).toFixed(2)}
          </span>
        </div>
      )}

      {loading ? (
        <div className="loading">Loading inventory…</div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">🃏</div>
          {search ? 'No cards match your search.' : 'No cards yet — click Add card to get started.'}
        </div>
      ) : (
        <div className="panel">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 32, padding: '0 8px' }}>
                  <input
                    type="checkbox"
                    checked={allFilteredSelected}
                    ref={el => { if (el) el.indeterminate = someFilteredSelected && !allFilteredSelected }}
                    onChange={toggleSelectAll}
                    title={allFilteredSelected ? 'Deselect all filtered' : 'Select all filtered'}
                  />
                </th>
                <th onClick={() => handleSort('name')} style={{ cursor: 'pointer', userSelect: 'none' }}>Card{sortArrow('name')}</th>
                <th onClick={() => handleSort('rarity')} style={{ cursor: 'pointer', userSelect: 'none' }}>Rarity{sortArrow('rarity')}</th>
                <th onClick={() => handleSort('condition')} style={{ cursor: 'pointer', userSelect: 'none' }}>Condition{sortArrow('condition')}</th>
                <th className="text-right" onClick={() => handleSort('quantity_owned')} style={{ cursor: 'pointer', userSelect: 'none' }}>Qty{sortArrow('quantity_owned')}</th>
                <th className="text-right" onClick={() => handleSort('cost_basis')} style={{ cursor: 'pointer', userSelect: 'none' }}>Cost basis{sortArrow('cost_basis')}</th>
                <th className="text-right" onClick={() => handleSort('tcgplayer_market')} style={{ cursor: 'pointer', userSelect: 'none' }}>TCGPlayer{sortArrow('tcgplayer_market')}</th>
                <th className="text-right" onClick={() => handleSort('ebay_sold_avg')} style={{ cursor: 'pointer', userSelect: 'none' }}>eBay avg{sortArrow('ebay_sold_avg')}</th>
                <th className="text-right" onClick={() => handleSort('market_value')} style={{ cursor: 'pointer', userSelect: 'none' }}>Market value{sortArrow('market_value')}</th>
                <th className="text-right" onClick={() => handleSort('unrealized_pnl')} style={{ cursor: 'pointer', userSelect: 'none' }}>P&L{sortArrow('unrealized_pnl')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {paginated.map(card => {
                const id   = card.card_id ?? card.id
                const prov = provenance[id] ?? []
                const isExpanded = expanded.has(id)
                return (
                  <>
                    <tr key={id} onClick={() => navigate(`/market?card=${id}`)}
                      style={{ cursor: 'pointer' }}>
                      <td style={{ width: 32, padding: '0 8px' }} onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(id)}
                          onChange={() => toggleSelect(id)}
                        />
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {prov.length > 0 && (
                            <span
                              onClick={e => { e.stopPropagation(); toggleExpand(id) }}
                              style={{ fontSize: 10, color: 'var(--text-muted)', userSelect: 'none', minWidth: 10, cursor: 'pointer' }}
                            >
                              {isExpanded ? '▾' : '▸'}
                            </span>
                          )}
                          <div>
                            <div className="name-cell">{card.name}</div>
                            <div className="set-cell">{card.set_name}{card.foil ? ' · Foil' : ''}</div>
                          </div>
                        </div>
                      </td>
                      <td><span className={`badge badge-${card.rarity}`}>{card.rarity}</span></td>
                      <td className="text-muted" style={{ fontSize: 12 }}>
                        {card.condition?.replace(/_/g, ' ')}
                      </td>
                      <td className="text-right">{card.quantity_owned}</td>
                      <td className="text-right text-muted">{usd(card.cost_basis)}</td>
                      <td className="text-right">{usd(card.tcgplayer_market)}</td>
                      <td className="text-right">{usd(card.ebay_sold_avg)}</td>
                      <td className="text-right text-gold">{usd(card.market_value)}</td>
                      <td className="text-right">
                        <span className={card.unrealized_pnl >= 0 ? 'text-success' : 'text-danger'}>
                          {card.unrealized_pnl != null
                            ? `${card.unrealized_pnl >= 0 ? '+' : ''}${usd(card.unrealized_pnl)}`
                            : '—'}
                        </span>
                      </td>
                      <td onClick={e => e.stopPropagation()}>
                        <div className="flex gap-8" style={{ justifyContent: 'flex-end' }}>
                          <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/market?card=${id}`)} title="View price history">↗</button>
                          <button className="btn btn-ghost btn-sm" onClick={() => openEdit(card)}>Edit</button>
                          <button className="btn btn-danger btn-sm" onClick={() => setDeleteId(id)}>Delete</button>
                        </div>
                      </td>
                    </tr>
                    {isExpanded && prov.length > 0 && (
                      <tr key={`${id}-prov`} style={{ background: 'var(--bg-raised)' }}>
                        <td colSpan={11} style={{ padding: '8px 16px 10px 32px' }}>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                            Pulled from
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {prov.map((p, i) => (
                              <span key={i} style={{
                                background: 'var(--bg-void)', border: '1px solid var(--border)',
                                borderRadius: 4, padding: '2px 8px', fontSize: 12, color: 'var(--text-secondary)',
                              }}>
                                {p.box_name} › Pack #{p.pack_number}
                                {p.quantity > 1 ? <span style={{ color: 'var(--text-muted)' }}> ×{p.quantity}</span> : ''}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </table>
          {totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setPage(0)} disabled={safePage === 0}>«</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0}>‹ Prev</button>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Page {safePage + 1} of {totalPages} · {filtered.length} cards
              </span>
              <button className="btn btn-ghost btn-sm" onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={safePage === totalPages - 1}>Next ›</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setPage(totalPages - 1)} disabled={safePage === totalPages - 1}>»</button>
            </div>
          )}
        </div>
      )}

      {/* Add / Edit modal */}
      {modal && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{modal === 'add' ? 'Add card' : 'Edit card'}</span>
              <button className="btn btn-ghost btn-sm" onClick={closeModal}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">Card name *</label>
                <input className="form-input" value={form.name} onChange={f('name')} placeholder="e.g. Grandmother of Sharks" />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Set</label>
                  <select className="form-select" value={form.set_name} onChange={f('set_name')}>
                    {config.sets.map(s => <option key={s}>{s}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Set code</label>
                  <input className="form-input" value={form.set_code} onChange={f('set_code')} placeholder="e.g. ALP" />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Rarity</label>
                  <select className="form-select" value={form.rarity} onChange={f('rarity')}>
                    {config.rarities.map(r => <option key={r}>{r}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Condition</label>
                  <select className="form-select" value={form.condition} onChange={f('condition')}>
                    {CONDITIONS.map(c => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Quantity owned</label>
                  <input className="form-input" type="number" min="0" value={form.quantity_owned} onChange={f('quantity_owned')} />
                </div>
                <div className="form-group">
                  {modal === 'edit' ? (
                    <div className="form-group">
                      <label className="form-label">Cost basis</label>
                      <div style={{ padding: '9px 12px', background: 'var(--bg-void)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: 13, color: 'var(--text-muted)' }}>
                        {form.cost_basis ? `$${Number(form.cost_basis).toFixed(4)} — auto-calculated from box` : 'Auto-calculated from box purchase price'}
                      </div>
                    </div>
                  ) : (
                    <div className="form-group">
                      <label className="form-label">Cost basis ($) <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
                      <input className="form-input" type="number" step="0.0001" min="0" value={form.cost_basis} onChange={f('cost_basis')} placeholder="e.g. 0.33" />
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>For cards not linked to a box. Leave blank to skip.</div>
                    </div>
                  )}
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">TCGPlayer ID (optional)</label>
                <input className="form-input" value={form.tcgplayer_id} onChange={f('tcgplayer_id')} placeholder="Product ID from TCGPlayer URL" />
              </div>
              <div className="form-group">
                <label className="form-label">Image URL (optional)</label>
                <input className="form-input" value={form.image_url} onChange={f('image_url')} placeholder="https://…" />
              </div>
              <div className="form-group">
                <label className="form-label">Notes</label>
                <textarea className="form-textarea" value={form.notes} onChange={f('notes')} placeholder="Any notes about this card…" />
              </div>
              <div className="form-row">
                <div className="form-group" style={{ flex: '0 0 auto' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: 22 }}>
                    <input type="checkbox" checked={form.foil} onChange={f('foil')} />
                    <span className="form-label" style={{ margin: 0 }}>Foil</span>
                  </label>
                </div>
                <div className="form-group">
                  <label className="form-label">Card type <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
                  <select className="form-select" value={form.card_type} onChange={f('card_type')}>
                    <option value="">— unspecified —</option>
                    {config.cardTypes.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
                  </select>
                </div>
              </div>
              {modal === 'add' && (
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Link to box <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
                    <select className="form-select" value={selBoxId} onChange={e => { setSelBoxId(e.target.value); fetchPacks(e.target.value) }}>
                      <option value="">— No box —</option>
                      {boxes.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Link to pack <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
                    {!selBoxId ? (
                      <select className="form-select" disabled>
                        <option>— Select a box first —</option>
                      </select>
                    ) : packs.length > 0 ? (
                      <select className="form-select" value={selPackId} onChange={e => setSelPackId(e.target.value)}>
                        <option value="">— Select pack —</option>
                        {packs.map(p => <option key={p.id} value={p.id}>Pack #{p.pack_number}</option>)}
                      </select>
                    ) : (
                      <div>
                        <input
                          className="form-input"
                          type="number" min="1" max="36"
                          value={newPackNumber}
                          onChange={e => setNewPackNumber(parseInt(e.target.value) || 1)}
                        />
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                          No packs exist yet — a new pack #{newPackNumber} will be created in this box
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={closeModal}>Cancel</button>
              <button className="btn btn-primary" onClick={save} disabled={!form.name || saving}>
                {saving ? 'Saving…' : modal === 'add' ? 'Add card' : 'Save changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {deleteId && (
        <div className="modal-overlay" onClick={() => setDeleteId(null)}>
          <div className="modal" style={{ maxWidth: 360 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Delete card?</span>
            </div>
            <div className="modal-body">
              <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
                This will permanently remove the card and all its price history. This cannot be undone.
              </p>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setDeleteId(null)}>Cancel</button>
              <button className="btn btn-danger" onClick={confirmDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* TCGPlayer export result modal */}
      {exportResult && (
        <div className="modal-overlay" onClick={() => setExportResult(null)}>
          <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">TCGPlayer CSV Export</span>
              <button className="btn btn-ghost btn-sm" onClick={() => setExportResult(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="alert-item success" style={{ marginBottom: 12 }}>
                <span className="alert-icon">✓</span>
                <div className="alert-content">
                  <div className="alert-title">{exportResult.exported} card{exportResult.exported !== 1 ? 's' : ''} exported</div>
                  <div className="alert-desc">
                    Upload via TCGPlayer Seller Portal → Pricing tab → Import to Staged
                  </div>
                </div>
              </div>
              {exportResult.skipped > 0 && (
                <div className="alert-item warning">
                  <span className="alert-icon">⚠️</span>
                  <div className="alert-content">
                    <div className="alert-title">{exportResult.skipped} card{exportResult.skipped !== 1 ? 's' : ''} skipped — no TCGPlayer ID</div>
                    <div className="alert-desc" style={{ fontSize: 11, marginTop: 4 }}>
                      {exportResult.skippedNames.slice(0, 8).join(', ')}
                      {exportResult.skippedNames.length > 8 ? ` …and ${exportResult.skippedNames.length - 8} more` : ''}
                    </div>
                  </div>
                </div>
              )}
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12 }}>
                Prices are pre-filled from TCGPlayer market data. Review and adjust in Staged Inventory before going live.
              </p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={() => setExportResult(null)}>Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}