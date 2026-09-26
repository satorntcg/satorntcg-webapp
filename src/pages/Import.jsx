import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useGame } from '../context/GameContext'
import { gameConfig } from '../lib/games'

function getSheetUrls(url, listingsGid) {
  const pubIdMatch = url.match(/\/d\/e\/([^/]+)/)
  if (!pubIdMatch) return null
  const pubId = pubIdMatch[1]
  return {
    cards:    `https://docs.google.com/spreadsheets/d/e/${pubId}/pub?gid=0&single=true&output=csv`,
    listings: listingsGid ? `https://docs.google.com/spreadsheets/d/e/${pubId}/pub?gid=${listingsGid}&single=true&output=csv` : null,
  }
}

function parseCsv(text) {
  const lines = text.trim().split('\n')
  if (lines.length < 2) return []
  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim().toLowerCase().replace(/ /g, '_'))
  return lines.slice(1).map(line => {
    const values = []
    let current = '', inQuotes = false
    for (const char of line) {
      if (char === '"') { inQuotes = !inQuotes; continue }
      if (char === ',' && !inQuotes) { values.push(current.trim()); current = ''; continue }
      current += char
    }
    values.push(current.trim())
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']))
  }).filter(row => Object.values(row).some(v => v !== ''))
}

function normalizeCard(row, config) {
  return {
    name:         row.name?.trim(),
    set_name:     (row.set_name ?? row.set ?? config.defaultSet).trim(),
    set_code:     row.set_code?.trim() || null,
    rarity:       config.rarityMap[row.rarity?.toLowerCase().trim()] ?? config.defaultRarity,
    condition:    'near_mint',
    foil:         ['true','yes','1','foil'].includes(row.foil?.toLowerCase().trim()),
    tcgplayer_id: row.tcgplayer_id?.trim() || null,
    image_url:    null,
    notes:        row.notes?.trim() || null,
    _pack_ref:    row.pack_ref?.trim() || null,
    _box_ref:     row.box_ref?.trim()  || null,
  }
}

async function runImport(cardRows, onLog, config, gameId) {
  let cardCount = 0, updatedCount = 0, skipped = 0, errorCount = 0
  const packIdCache = {}

  for (const raw of cardRows) {
    const card = normalizeCard(raw, config)
    const packRef = card._pack_ref
    const boxRef  = card._box_ref
    delete card._pack_ref
    delete card._box_ref
    if (!card.name) { onLog('warn', 'Skipping row with no name'); continue }

    // Resolve pack_ref → pack id, creating the pack if it doesn't exist yet
    let packId = null
    if (packRef) {
      if (packIdCache[packRef] === undefined) {
        const { data: existingPack } = await supabase.from('packs').select('id, pack_number').eq('pack_ref', packRef).maybeSingle()
        if (existingPack) {
          packIdCache[packRef] = existingPack.id
          const refNumMatch = packRef.match(/_p(\d+)$/i)
          if (refNumMatch) {
            const expectedNum = parseInt(refNumMatch[1])
            if (existingPack.pack_number !== expectedNum) {
              await supabase.from('packs').update({ pack_number: expectedNum }).eq('id', existingPack.id)
              onLog('info', `Corrected pack "${packRef}": #${existingPack.pack_number} → #${expectedNum}`)
            }
          }
        } else if (boxRef) {
          const { data: box } = await supabase.from('boxes').select('id').eq('box_ref', boxRef).maybeSingle()
          if (!box) {
            onLog('warn', `No box found for box_ref "${boxRef}" — skipping ${card.name}`)
            packIdCache[packRef] = null
          } else {
            const refNumMatch = packRef.match(/_p(\d+)$/i)
            let packNumber = refNumMatch ? parseInt(refNumMatch[1]) : null
            if (!packNumber) {
              const { data: maxPack } = await supabase.from('packs').select('pack_number')
                .eq('box_id', box.id).order('pack_number', { ascending: false }).limit(1).maybeSingle()
              packNumber = (maxPack?.pack_number ?? 0) + 1
            }
            const { data: newPack, error } = await supabase.from('packs')
              .insert({ box_id: box.id, pack_ref: packRef, pack_number: packNumber })
              .select('id').single()
            if (error) {
              onLog('error', `Failed to create pack "${packRef}": ${error.message}`)
              packIdCache[packRef] = null
            } else {
              onLog('success', `Created pack "${packRef}" (#${packNumber}) in box "${boxRef}"`)
              packIdCache[packRef] = newPack.id
            }
          }
        } else {
          onLog('warn', `Pack "${packRef}" not found and no box_ref provided — skipping ${card.name}`)
          packIdCache[packRef] = null
        }
      }
      packId = packIdCache[packRef]
      if (!packId) { skipped++; continue }
    }

    // Find existing card
    let existing = null
    if (card.tcgplayer_id) {
      const { data } = await supabase.from('cards').select('id, quantity_owned')
        .eq('tcgplayer_id', card.tcgplayer_id).eq('game_id', gameId).maybeSingle()
      existing = data
    }
    if (!existing) {
      const { data } = await supabase.from('cards').select('id, quantity_owned')
        .ilike('name', card.name).ilike('set_name', card.set_name).eq('condition', card.condition).eq('foil', card.foil).eq('game_id', gameId).maybeSingle()
      existing = data
    }

    // If card exists and is already linked to this pack → skip
    if (existing && packId) {
      const { data: link } = await supabase.from('pack_cards').select('id')
        .eq('pack_id', packId).eq('card_id', existing.id).maybeSingle()
      if (link) { onLog('info', `Skipped (exists): ${card.name} → ${packRef}`); skipped++; continue }
    }

    // Insert card if new, otherwise increment quantity. When linking to a pack,
    // the pack_cards insert below adds the copy via trg_sync_quantity_owned,
    // so don't also count it here.
    let cardId
    if (existing) {
      cardId = existing.id
      if (!packId) {
        const { error } = await supabase.from('cards')
          .update({ quantity_owned: Number(existing.quantity_owned ?? 0) + 1 }).eq('id', cardId)
        if (error) { onLog('error', `Card quantity (${card.name}): ${error.message}`); errorCount++; continue }
      }
      onLog('info', `Linked: ${card.name} → ${packRef ?? 'no pack'}`)
      updatedCount++
    } else {
      const { data, error } = await supabase.from('cards').insert({ ...card, quantity_owned: packId ? 0 : 1, game_id: gameId }).select('id').single()
      if (error) { onLog('error', `Card (${card.name}): ${error.message}`); errorCount++; continue }
      cardId = data.id
      onLog('success', `Added: ${card.name} (${card.rarity})`)
      cardCount++
    }

    // Link card to pack
    if (packId) {
      const { error } = await supabase.from('pack_cards').insert({ pack_id: packId, card_id: cardId, quantity: 1 })
      if (error) onLog('warn', `Link failed ${card.name} → ${packRef}: ${error.message}`)
    }
  }

  return { cardCount, updatedCount, skipped, errorCount }
}

async function runListingsImport(listingRows, onLog, gameId, config) {
  let created = 0, skipped = 0, errorCount = 0

  // Group rows by listing_ref
  const groups = {}
  for (const row of listingRows) {
    const ref = row.listing_ref?.trim()
    if (!ref) { onLog('warn', `Row missing listing_ref — skipping`); continue }
    if (!groups[ref]) groups[ref] = []
    groups[ref].push(row)
  }

  onLog('info', `Found ${Object.keys(groups).length} listings to process`)

  for (const [ref, rows] of Object.entries(groups)) {
    const first    = rows[0]
    const price    = parseFloat(first.price)    || 0
    const shipping = parseFloat(first.shipping) || 0
    const condition = 'Near Mint'
    const rawStatus = first.status?.trim().toLowerCase()
    const status   = rawStatus === 'sold' ? 'sold' : 'active'
    const soldDate = first.sold_date?.trim() || null
    const ebayUrl  = first.ebay_url?.trim()  || null
    const notes    = first.notes?.trim()     || null

    if (!price) { onLog('warn', `Skipping ${ref} — no price`); skipped++; continue }

    // Dedup check via import_ref tag in notes
    const { data: existing } = await supabase
      .from('ebay_listings').select('id')
      .ilike('notes', `%import_ref:${ref}%`)
      .maybeSingle()
    if (existing) { onLog('info', `Skipped (exists): ${ref}`); skipped++; continue }

    // Resolve card IDs
    const cardIds = []
    const cardBreakdown = []
    for (const row of rows) {
      const name    = row.card_name?.trim()
      const setName = row.set_name?.trim() || null
      if (!name) continue
      const foilVal = row.foil?.trim().toLowerCase()
      const isFoil = ['true','yes','1','foil'].includes(foilVal)
      let query = supabase.from('cards').select('id, name').ilike('name', name).eq('foil', isFoil).eq('game_id', gameId)
      if (setName) query = query.ilike('set_name', setName)
      const { data: match } = await query.maybeSingle()
      if (match) { cardIds.push(match.id); cardBreakdown.push(match.name) }
      else onLog('warn', `Card not found in inventory: "${name}" (ref: ${ref})`)
    }

    // Block import if no cards matched
    if (cardIds.length === 0) {
      onLog('error', `Skipping ${ref} — no cards matched in inventory (checked: ${rows.map(r => r.card_name?.trim()).filter(Boolean).join(', ')})`)
      errorCount++; continue
    }

    // Cost basis from matched cards
    let costBasis = null
    if (cardIds.length) {
      const { data: priceData } = await supabase
        .from('v_latest_prices').select('card_id, cost_basis').in('card_id', cardIds)
      if (priceData?.length) costBasis = priceData.reduce((s, p) => s + (p.cost_basis || 0), 0)
    }

    const title = cardBreakdown.length === 1
      ? `${cardBreakdown[0]} — ${config.displayName}`
      : cardBreakdown.length > 1
        ? `${config.displayName} Lot — ${cardBreakdown.join(', ')}`
        : `${config.displayName} Lot (${ref})`

    const fullNotes = [
      cardBreakdown.length > 1 ? `Cards: ${cardBreakdown.join(', ')}` : null,
      notes,
      `import_ref:${ref}`,
    ].filter(Boolean).join('\n')

    const ebayFee     = parseFloat((price * 0.129 + 0.30).toFixed(2))
    const netProceeds = parseFloat((price - ebayFee - shipping).toFixed(2))
    const trueProfit  = costBasis ? parseFloat((netProceeds - costBasis).toFixed(2)) : netProceeds
    const soldPayload = status === 'sold' ? {
      sold_price:    price,
      sold_shipping: shipping,
      sold_ebay_fee: ebayFee,
      net_profit:    trueProfit,
      sold_at:       soldDate ? new Date(soldDate).toISOString() : new Date().toISOString(),
    } : {}

    const { data: newListing, error } = await supabase.from('ebay_listings').insert({
      card_id:       cardIds.length === 1 ? cardIds[0] : null,
      title,
      listed_price:  price,
      shipping_cost: shipping,
      condition,
      notes:         fullNotes,
      cost_basis:    costBasis ? parseFloat(costBasis.toFixed(4)) : null,
      status,
      ebay_url:      ebayUrl || null,
      ...soldPayload,
    }).select('id').single()

    if (error) { onLog('error', `Failed ${ref}: ${error.message}`); errorCount++; continue }

    // Insert into ebay_listing_cards junction table
    if (newListing && cardIds.length > 0) {
      const perCardPrice = parseFloat((price / cardIds.length).toFixed(2))
      const lcRows = cardIds.map(cardId => ({ listing_id: newListing.id, card_id: cardId, price: perCardPrice }))
      const { error: lcErr } = await supabase.from('ebay_listing_cards').insert(lcRows)
      if (lcErr) onLog('warn', `Card links failed for ${ref}: ${lcErr.message}`)
      else onLog('info', `Linked ${lcRows.length} card(s) to listing ${ref}`)
    }

    // Increment quantity_listed for each matched card
    for (const cardId of cardIds) {
      const { data: cardRow } = await supabase.from('cards').select('quantity_listed').eq('id', cardId).single()
      if (cardRow) await supabase.from('cards')
        .update({ quantity_listed: (cardRow.quantity_listed ?? 0) + 1 }).eq('id', cardId)
    }

    onLog('success', `Created: ${title} @ $${price}${cardIds.length > 1 ? ` (${cardIds.length} cards)` : ''}`)
    created++
  }

  return { created, skipped, errorCount }
}

export default function Import() {
  const { activeGame, games } = useGame()
  const [importGame, setImportGame] = useState(activeGame)
  const importConfig = gameConfig(importGame.slug)
  const [sheetUrl, setSheetUrl]     = useState('https://docs.google.com/spreadsheets/d/e/2PACX-1vTgjSY3ZKa5WFKauWOjlVQfuKCqhQD3p2c485h1jMV_iP8oatHLc_lQn3_4dGDO66VagE2hcTbGZWQ5/pub?output=csv')
  const [listingsGid, setListingsGid] = useState('1267977612')
  const [status, setStatus]         = useState('idle')
  const [logs, setLogs]             = useState([])
  const [preview, setPreview]       = useState(null)
  const [summary, setSummary]       = useState(null)
  const [activeTab, setActiveTab]   = useState('cards') // 'cards' | 'listings' | 'ebay_csv'
  const [listingPreview, setListingPreview] = useState(null)
  const [listingSummary, setListingSummary] = useState(null)
  const [ebayCsvRows, setEbayCsvRows]     = useState(null)
  const [ebayCsvSummary, setEbayCsvSummary] = useState(null)
  const [ebayActiveRows, setEbayActiveRows] = useState(null)
  const [ebayActiveSummary, setEbayActiveSummary] = useState(null)

  const addLog = (type, message) =>
    setLogs(prev => [...prev, { type, message, id: Date.now() + Math.random() }])

  async function fetchPreview() {
    if (!sheetUrl.trim()) return
    setStatus('fetching'); setLogs([])
    const urls = getSheetUrls(sheetUrl, listingsGid)
    if (!urls) { addLog('error', 'Could not parse URL'); setStatus('error'); return }
    try {
      if (activeTab === 'cards') {
        setPreview(null); setSummary(null)
        addLog('info', 'Fetching Cards…')
        const cardsRes = await fetch(urls.cards)
        if (!cardsRes.ok) throw new Error(`Cards sheet not accessible (${cardsRes.status})`)
        const cardRows = parseCsv(await cardsRes.text())
        addLog('success', `Found ${cardRows.length} cards`)
        setPreview({ cards: cardRows })
      } else {
        setListingPreview(null); setListingSummary(null)
        if (!urls.listings) { addLog('error', 'No listings gid set'); setStatus('error'); return }
        addLog('info', 'Fetching Listings tab…')
        const listRes  = await fetch(urls.listings)
        if (!listRes.ok) throw new Error(`Listings tab not accessible (${listRes.status})`)
        const listRows = parseCsv(await listRes.text())
        setListingPreview(listRows)
        addLog('success', `Found ${listRows.length} listing rows`)
      }
      setStatus('idle')
    } catch (err) {
      addLog('error', String(err))
      setStatus('error')
    }
  }

  async function doImport() {
    if (!preview) return
    setStatus('importing'); setLogs([])
    const result = await runImport(preview.cards, addLog, importConfig, importGame.id)
    setSummary(result); setStatus('done')
  }

  async function doListingsImport() {
    if (!listingPreview) return
    setStatus('importing'); setLogs([])
    const result = await runListingsImport(listingPreview, addLog, importGame.id, importConfig)
    setListingSummary(result); setStatus('done')
  }

  const logColors = {
    success: 'var(--success)', error: 'var(--danger)',
    warn: 'var(--warning)', info: 'var(--text-muted)',
  }

  // Group listing preview rows by ref for display
  const listingGroups = listingPreview ? Object.entries(
    listingPreview.reduce((acc, row) => {
      const ref = row.listing_ref?.trim() || '(no ref)'
      if (!acc[ref]) acc[ref] = []
      acc[ref].push(row)
      return acc
    }, {})
  ) : []

  return (
    <div className="page" style={{ maxWidth: 900 }}>
      <div className="page-header">
        <h1 className="page-title">Bulk Import</h1>
        <p className="page-subtitle">Import cards and eBay listings from Google Sheets</p>
      </div>

      {/* Tab selector */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, alignItems: 'center', flexWrap: 'wrap' }}>
        {[['cards', 'Cards'], ['listings', 'eBay Listings'], ['ebay_csv', 'eBay Order History']].map(([id, label]) => (
          <button key={id} className={`btn btn-sm ${activeTab === id ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setActiveTab(id)}>{label}</button>
        ))}
        {games.length > 1 && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Importing into</span>
            <select
              className="form-select"
              style={{ fontSize: 12, width: 'auto' }}
              value={importGame.id}
              onChange={e => setImportGame(games.find(g => g.id === e.target.value))}
            >
              {games.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
        )}
      </div>

      {/* ── Cards / Boxes / Packs tab ── */}
      {activeTab === 'cards' && (
        <>
          {/* Sheet structure */}
          <div className="panel mb-16">
            <div className="panel-header"><span className="panel-title">Google Sheet structure — Cards tab</span></div>
            <div className="panel-body" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              <div style={{ fontFamily:'monospace', fontSize:11, background:'var(--bg-void)', padding:'8px 12px', borderRadius:6, marginBottom:4 }}>
                name | set_name | set_code | rarity | foil | pack_ref | box_ref | tcgplayer_id | notes
              </div>
              <div style={{ fontSize:12, color:'var(--text-muted)', marginBottom:12 }}>↳ Condition defaults to near_mint. <code style={{ background:'var(--bg-void)', padding:'1px 5px', borderRadius:4 }}>pack_ref</code> links the card to a pack — if the pack doesn't exist yet, <code style={{ background:'var(--bg-void)', padding:'1px 5px', borderRadius:4 }}>box_ref</code> is used to create it.</div>
              <div style={{ background:'var(--info-bg)', border:'1px solid rgba(76,132,201,0.25)', borderRadius:8, padding:'10px 14px', fontSize:12 }}>
                <strong style={{ color:'var(--info)' }}>Safe to re-run:</strong> Cards already linked to their pack are skipped. New cards are inserted; existing cards pulled from a new pack get a new pack link added.
              </div>
            </div>
          </div>

          {/* Inputs */}
          <div className="panel mb-16">
            <div className="panel-header"><span className="panel-title">Your sheet details</span></div>
            <div className="panel-body">
              <div className="form-group">
                <label className="form-label">Published sheet URL</label>
                <input className="form-input" value={sheetUrl} onChange={e => setSheetUrl(e.target.value)} />
              </div>
              <button className="btn btn-primary" onClick={fetchPreview}
                disabled={!sheetUrl.trim() || status === 'fetching'}>
                {status === 'fetching' ? 'Fetching…' : 'Preview import'}
              </button>
            </div>
          </div>

          {/* Preview */}
          {preview && (
            <div className="panel mb-16">
              <div className="panel-header">
                <span className="panel-title">Preview</span>
                <span style={{ fontSize:12, color:'var(--text-muted)' }}>{preview.cards.length} cards</span>
              </div>
              <table className="data-table">
                <thead><tr>
                  <th>Name</th><th>Set</th><th>Rarity</th><th>Foil</th><th>Pack ref</th><th>Box ref</th><th>TCGPlayer ID</th>
                </tr></thead>
                <tbody>
                  {preview.cards.slice(0, 20).map((row, i) => {
                    const c = normalizeCard(row, importConfig)
                    return (
                      <tr key={i}>
                        <td className="name-cell">{c.name || <span className="text-danger">missing!</span>}</td>
                        <td>{c.set_name}</td>
                        <td><span className={`badge badge-${c.rarity}`}>{c.rarity}</span></td>
                        <td>{c.foil ? '✓' : ''}</td>
                        <td style={{ fontSize:11, color:'var(--text-muted)' }}>{c._pack_ref || '—'}</td>
                        <td style={{ fontSize:11, color:'var(--text-muted)' }}>{c._box_ref || '—'}</td>
                        <td style={{ fontSize:11, color:'var(--text-muted)' }}>{row.tcgplayer_id || '—'}</td>
                      </tr>
                    )
                  })}
                  {preview.cards.length > 20 && (
                    <tr><td colSpan={7} style={{ textAlign:'center', color:'var(--text-muted)', fontSize:12 }}>…and {preview.cards.length - 20} more</td></tr>
                  )}
                </tbody>
              </table>
              <div style={{ padding:'14px 20px', borderTop:'1px solid var(--border)', display:'flex', justifyContent:'flex-end' }}>
                <button className="btn btn-primary" onClick={doImport} disabled={status === 'importing'}>
                  {status === 'importing' ? '⟳ Importing…' : `Import ${preview.cards.length} cards`}
                </button>
              </div>
            </div>
          )}

          {summary && (
            <div className={`alert-item ${summary.errorCount === 0 ? 'success' : 'warning'}`}>
              <span className="alert-icon">{summary.errorCount === 0 ? '✓' : '⚠️'}</span>
              <div className="alert-content">
                <div className="alert-title">Import complete</div>
                <div className="alert-desc">
                  {summary.cardCount} new · {summary.updatedCount} linked · {summary.skipped} skipped · {summary.errorCount} errors
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── eBay Listings tab ── */}
      {activeTab === 'listings' && (
        <>
          {/* Schema */}
          <div className="panel mb-16">
            <div className="panel-header"><span className="panel-title">Listings tab structure</span></div>
            <div className="panel-body" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              <div style={{ fontFamily:'monospace', fontSize:11, background:'var(--bg-void)', padding:'8px 12px', borderRadius:6, marginBottom:8 }}>
                listing_ref | card_name | set_name | foil | price | shipping | status | sold_date | ebay_url | notes
              </div>
              <div style={{ fontSize:12, color:'var(--text-muted)', marginBottom:12 }}>
                ↳ One row per card. Cards with the same <code style={{ background:'var(--bg-void)', padding:'1px 5px', borderRadius:4 }}>listing_ref</code> are grouped into one eBay listing. Price, shipping, condition, ebay_url and notes are taken from the first row of each group.
              </div>

              {/* Example table */}
              <div style={{ fontSize:11, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:6 }}>Example</div>
              <table style={{ borderCollapse:'collapse', fontSize:11, fontFamily:'monospace', marginBottom:12 }}>
                {[
                  ['listing_ref','card_name','set_name','foil','price','shipping','status','sold_date','ebay_url','notes'],
                  ['lot_001','Dragul','Gothic','false','12.50','4.00','active','','https://ebay.com/itm/123',''],
                  ['lot_001','Thornwood','Gothic','false','','','',''],
                  ['lot_002','Accusation','Gothic','false','15.00','4.00','sold','2026-05-20','',''],
                ].map((row, i) => (
                  <tr key={i} style={{ background: i===0 ? 'var(--bg-raised)' : 'transparent' }}>
                    {row.map((cell, j) => (
                      <td key={j} style={{ padding:'3px 10px', border:'1px solid var(--border)', color: i===0 ? 'var(--text-muted)' : 'var(--text-primary)' }}>{cell || <span style={{ color:'var(--text-muted)' }}>—</span>}</td>
                    ))}
                  </tr>
                ))}
              </table>

              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                <div style={{ background:'var(--info-bg)', border:'1px solid rgba(76,132,201,0.25)', borderRadius:8, padding:'10px 14px', fontSize:12 }}>
                  <strong style={{ color:'var(--info)' }}>Safe to re-run:</strong> Each listing_ref is tagged internally — duplicates are skipped.
                </div>
                <div style={{ background:'var(--warning-bg)', border:'1px solid rgba(201,137,76,0.25)', borderRadius:8, padding:'10px 14px', fontSize:12 }}>
                  <strong style={{ color:'var(--warning)' }}>Card matching:</strong> Matched by name + set_name. Card must already exist in inventory.
                </div>
              </div>
            </div>
          </div>

          {/* Inputs */}
          <div className="panel mb-16">
            <div className="panel-header"><span className="panel-title">Sheet details</span></div>
            <div className="panel-body">
              <div className="form-group">
                <label className="form-label">Published sheet URL</label>
                <input className="form-input" value={sheetUrl} onChange={e => setSheetUrl(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Listings tab gid</label>
                <input className="form-input" placeholder="Click Listings tab, get gid from URL" value={listingsGid} onChange={e => setListingsGid(e.target.value)} />
              </div>
              <button className="btn btn-primary" onClick={fetchPreview}
                disabled={!sheetUrl.trim() || !listingsGid.trim() || status === 'fetching'}>
                {status === 'fetching' ? 'Fetching…' : 'Preview listings'}
              </button>
            </div>
          </div>

          {/* Listing preview */}
          {listingPreview && listingGroups.length > 0 && (
            <div className="panel mb-16">
              <div className="panel-header">
                <span className="panel-title">Preview — {listingGroups.length} listings</span>
                <span style={{ fontSize:12, color:'var(--text-muted)' }}>{listingPreview.length} rows</span>
              </div>
              <table className="data-table">
                <thead><tr>
                  <th>Ref</th><th>Cards</th><th className="text-right">Price</th>
                  <th className="text-right">Shipping</th><th>Foil</th><th>Status</th><th>eBay URL</th>
                </tr></thead>
                <tbody>
                  {listingGroups.slice(0, 20).map(([ref, rows]) => {
                    const first = rows[0]
                    const cardNames = rows.map(r => r.card_name?.trim()).filter(Boolean)
                    const hasFoil = rows.some(r => ['true','yes','1','foil'].includes(r.foil?.toLowerCase()))
                    const listingStatus = (first.status||'active').toLowerCase()
                    return (
                      <tr key={ref}>
                        <td style={{ fontSize:11, color:'var(--text-muted)', fontFamily:'monospace' }}>{ref}</td>
                        <td>
                          {cardNames.map((name, i) => (
                            <div key={i} className="name-cell" style={{ fontSize:12 }}>{name}</div>
                          ))}
                        </td>
                        <td className="text-right text-gold">${parseFloat(first.price||0).toFixed(2)}</td>
                        <td className="text-right text-muted">${parseFloat(first.shipping||0).toFixed(2)}</td>
                        <td style={{ color: 'var(--gold)' }}>{hasFoil ? '✦' : '—'}</td>
                        <td><span className={`badge ${listingStatus === 'sold' ? 'badge-ok' : 'badge-active'}`}>{listingStatus}</span></td>
                        <td>
                          {first.ebay_url ? (
                            <a href={first.ebay_url} target="_blank" rel="noreferrer"
                              style={{ fontSize:11, color:'var(--info)', textDecoration:'none' }}>View ↗</a>
                          ) : <span className="text-muted">—</span>}
                        </td>
                      </tr>
                    )
                  })}
                  {listingGroups.length > 20 && (
                    <tr><td colSpan={7} style={{ textAlign:'center', color:'var(--text-muted)', fontSize:12 }}>…and {listingGroups.length - 20} more</td></tr>
                  )}
                </tbody>
              </table>
              <div style={{ padding:'14px 20px', borderTop:'1px solid var(--border)', display:'flex', justifyContent:'flex-end' }}>
                <button className="btn btn-primary" onClick={doListingsImport} disabled={status === 'importing'}>
                  {status === 'importing' ? '⟳ Importing…' : `Import ${listingGroups.length} listings`}
                </button>
              </div>
            </div>
          )}

          {listingSummary && (
            <div className={`alert-item ${listingSummary.errorCount === 0 ? 'success' : 'warning'}`}>
              <span className="alert-icon">{listingSummary.errorCount === 0 ? '✓' : '⚠️'}</span>
              <div className="alert-content">
                <div className="alert-title">Listings import complete</div>
                <div className="alert-desc">
                  {listingSummary.created} created · {listingSummary.skipped} skipped · {listingSummary.errorCount} errors
                </div>
              </div>
            </div>
          )}
        </>
      )}


      {/* ── eBay Order History CSV tab ── */}
      {activeTab === 'ebay_csv' && (
        <>
          <div className="panel mb-16">
            <div className="panel-header"><span className="panel-title">Import from eBay Order History CSV</span></div>
            <div className="panel-body" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              <p style={{ marginBottom: 12 }}>Download your order history from <strong style={{ color: 'var(--text-primary)' }}>eBay Seller Hub → Orders → Download report</strong>, then upload the CSV file here.</p>
              <p style={{ marginBottom: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                To link sold items to inventory, add two columns to a separate sheet and paste matching data:
              </p>
              <div style={{ fontFamily: 'monospace', fontSize: 11, background: 'var(--bg-void)', padding: '8px 12px', borderRadius: 6, marginBottom: 8 }}>
                order_number | tcgplayer_id | card_name
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                ↳ <strong style={{ color: 'var(--text-primary)' }}>tcgplayer_id</strong> takes priority. Falls back to card_name. Leave blank to skip inventory update.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div style={{ background: 'var(--info-bg)', border: '1px solid rgba(76,132,201,0.25)', borderRadius: 8, padding: '10px 14px', fontSize: 12 }}>
                  <strong style={{ color: 'var(--info)' }}>What gets imported:</strong> Each order becomes a sold listing. Multi-item orders are grouped by order number.
                </div>
                <div style={{ background: 'var(--warning-bg)', border: '1px solid rgba(201,137,76,0.25)', borderRadius: 8, padding: '10px 14px', fontSize: 12 }}>
                  <strong style={{ color: 'var(--warning)' }}>Dedup:</strong> Orders already imported (matched by eBay order number) are skipped.
                </div>
              </div>
            </div>
          </div>

          <div className="panel mb-16">
            <div className="panel-header"><span className="panel-title">Upload CSV</span></div>
            <div className="panel-body">
              <div className="form-group">
                <label className="form-label">eBay Orders CSV file</label>
                <input
                  type="file"
                  accept=".csv"
                  className="form-input"
                  onChange={async e => {
                    const file = e.target.files?.[0]
                    if (!file) return
                    const text = await file.text()
                    // Skip first blank row, parse from second row
                    const lines = text.split('\n').filter(l => l.trim() && l.trim() !== ','.repeat(40))
                    const headerLine = lines.find(l => l.includes('Sales Record Number'))
                    if (!headerLine) { addLog('error', 'Could not find header row — make sure this is an eBay Orders CSV'); return }
                    const headerIdx = lines.indexOf(headerLine)
                    const csvText = lines.slice(headerIdx).join('\n')
                    const rows = parseCsv(csvText)
                    // Forward-fill order_number — eBay only puts it on the first row of multi-item orders
                    let lastOrderNum = ''
                    let lastSalesRef = ''
                    const filledRows = rows.map(row => {
                      if (row.order_number?.trim()) lastOrderNum = row.order_number.trim()
                      if (row.sales_record_number?.trim()) lastSalesRef = row.sales_record_number.trim()
                      return { ...row, order_number: lastOrderNum, sales_record_number: lastSalesRef }
                    })
                    const validRows = filledRows.filter(r => r.item_number?.trim() || r.sold_for?.trim())
                    setEbayCsvRows(validRows)
                    addLog('success', `Parsed ${validRows.length} order rows from CSV`)
                  }}
                />
              </div>
            </div>
          </div>

          {/* Preview */}
          {ebayCsvRows && ebayCsvRows.length > 0 && (() => {
            // Group by order_number (forward-filled at parse time)
            const orders = {}
            ebayCsvRows.forEach(row => {
              const key = row.order_number?.trim() || row.sales_record_number?.trim() || 'unknown'
              if (!orders[key]) orders[key] = []
              orders[key].push(row)
            })
            const orderList = Object.entries(orders)
            return (
              <div className="panel mb-16">
                <div className="panel-header">
                  <span className="panel-title">Preview — {orderList.length} orders</span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{ebayCsvRows.length} line items</span>
                </div>
                <table className="data-table">
                  <thead><tr>
                    <th>Order #</th>
                    <th>Title(s)</th>
                    <th className="text-right">Sold for</th>
                    <th className="text-right">Shipping</th>
                    <th className="text-right">eBay fee</th>
                    <th>Date</th>
                  </tr></thead>
                  <tbody>
                    {orderList.slice(0, 20).map(([orderNum, rows]) => {
                      const first = rows[0]
                      const totalSold = rows.reduce((s, r) => s + (parseFloat(r.sold_for?.replace('$','')) || 0), 0)
                      const totalShipping = 5.00  // fixed default
                      const totalFee = rows.reduce((s, r) => s + (parseFloat(r.ebay_collected_tax?.replace('$','')) || 0), 0)
                      return (
                        <tr key={orderNum}>
                          <td style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-muted)' }}>{first.sales_record_number}</td>
                          <td>
                            {rows.filter(r => r.item_title).map((r, i) => (
                              <div key={i} className="name-cell" style={{ fontSize: 12 }}>{r.item_title}</div>
                            ))}
                          </td>
                          <td className="text-right text-gold">${totalSold.toFixed(2)}</td>
                          <td className="text-right text-muted">${totalShipping.toFixed(2)}</td>
                          <td className="text-right text-muted">${totalFee.toFixed(2)}</td>
                          <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{first.sale_date}</td>
                        </tr>
                      )
                    })}
                    {orderList.length > 20 && (
                      <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>…and {orderList.length - 20} more orders</td></tr>
                    )}
                  </tbody>
                </table>
                <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end' }}>
                  <button className="btn btn-primary" disabled={status === 'importing'}
                    onClick={async () => {
                      setStatus('importing'); setLogs([])
                      let created = 0, skipped = 0, errorCount = 0

                      // Group by order_number (already forward-filled at parse time)
                      const orders = {}
                      ebayCsvRows.forEach(row => {
                        const key = row.order_number?.trim() || row.sales_record_number?.trim() || 'unknown'
                        if (!orders[key]) orders[key] = []
                        orders[key].push(row)
                      })

                      for (const [orderNum, rows] of Object.entries(orders)) {
                        const first = rows[0]
                        const salesRef = first.sales_record_number?.trim()

                        // Dedup by order_number in notes
                        const { data: existing } = await supabase
                          .from('ebay_listings')
                          .select('id')
                          .ilike('notes', `%ebay_order:${orderNum}%`)
                          .maybeSingle()
                        if (existing) { addLog('info', `Skipped (exists): order ${salesRef}`); skipped++; continue }

                        const totalSold     = rows.reduce((s, r) => s + (parseFloat(r.sold_for?.replace('$','')) || 0), 0)
                        const totalShipping = 5.00  // fixed default shipping cost
                        const totalFee      = rows.reduce((s, r) => s + (parseFloat(r.ebay_collected_tax?.replace('$','')) || 0), 0)
                        const ebayFee       = parseFloat((totalSold * 0.129 + 0.30).toFixed(2))
                        const netProfit     = parseFloat((totalSold - ebayFee - totalShipping).toFixed(2))

                        const titles = rows.filter(r => r.item_title).map(r => r.item_title)
                        const title  = titles.length === 1 ? titles[0] : `eBay Order ${salesRef} — ${titles.length} items`

                        const saleDate = first.sale_date
                          ? new Date(first.sale_date.replace(/-/g, ' ')).toISOString()
                          : new Date().toISOString()

                        const ebayItemNum = rows.find(r => r.item_number)?.item_number
                        const ebayUrl = ebayItemNum ? `https://www.ebay.com/itm/${ebayItemNum}` : null

                        const notes = [
                          titles.length > 1 ? `Items: ${titles.join(', ')}` : null,
                          `ebay_order:${orderNum}`,
                          `Sales record: ${salesRef}`,
                        ].filter(Boolean).join('\n')

                        // Match card via tcgplayer_id or card_name from extra columns
                        let matchedCardId = null
                        const tcgId   = first.tcgplayer_id?.trim()
                        const cardName = first.card_name?.trim()

                        if (tcgId) {
                          const { data: cardMatch } = await supabase
                            .from('cards').select('id, quantity_owned, quantity_listed')
                            .eq('tcgplayer_id', tcgId).eq('game_id', importGame.id).maybeSingle()
                          if (cardMatch) matchedCardId = cardMatch
                        } else if (cardName) {
                          const { data: cardMatch } = await supabase
                            .from('cards').select('id, quantity_owned, quantity_listed')
                            .ilike('name', cardName).eq('game_id', importGame.id).maybeSingle()
                          if (cardMatch) matchedCardId = cardMatch
                        }

                        const { data: newListing, error } = await supabase.from('ebay_listings').insert({
                          card_id:       matchedCardId?.id ?? null,
                          title,
                          listed_price:  totalSold,
                          shipping_cost: totalShipping,
                          sold_price:    totalSold,
                          sold_shipping: totalShipping,
                          sold_ebay_fee: ebayFee,
                          net_profit:    netProfit,
                          sold_at:       saleDate,
                          status:        'sold',
                          ebay_url:      ebayUrl,
                          notes,
                          cost_basis:    matchedCardId ? null : null,
                        }).select('id').single()

                        if (error) {
                          addLog('error', `Order ${salesRef}: ${error.message}`)
                          errorCount++; continue
                        }

                        // Update inventory if card was matched
                        if (matchedCardId) {
                          await supabase.from('cards').update({
                            quantity_owned: Math.max(0, (matchedCardId.quantity_owned ?? 0) - 1),
                          }).eq('id', matchedCardId.id)
                          addLog('info', `Matched card: ${cardName || tcgId} — inventory updated`)
                        } else if (tcgId || cardName) {
                          addLog('warn', `Card not found in inventory: ${cardName || tcgId}`)
                        }

                        addLog('success', `Imported order ${salesRef}: ${title} @ $${totalSold.toFixed(2)}`)
                        created++
                      }

                      setEbayCsvSummary({ created, skipped, errorCount })
                      setStatus('done')
                    }}
                  >
                    {status === 'importing' ? '⟳ Importing…' : `Import ${Object.keys((() => { const o = {}; ebayCsvRows.forEach(r => { const k = r.order_number?.trim() || 'unknown'; if (!o[k]) o[k] = []; o[k].push(r) }); return o })()).length} orders`}
                  </button>
                </div>
              </div>
            )
          })()}

          {ebayCsvSummary && (
            <div className={`alert-item ${ebayCsvSummary.errorCount === 0 ? 'success' : 'warning'}`}>
              <span className="alert-icon">{ebayCsvSummary.errorCount === 0 ? '✓' : '⚠️'}</span>
              <div className="alert-content">
                <div className="alert-title">eBay order import complete</div>
                <div className="alert-desc">
                  {ebayCsvSummary.created} orders imported · {ebayCsvSummary.skipped} skipped · {ebayCsvSummary.errorCount} errors
                </div>
              </div>
            </div>
          )}
        </>
      )}


          {/* ── Active Listings CSV ── */}
          <div className="panel mb-16" style={{ marginTop: 24 }}>
            <div className="panel-header"><span className="panel-title">Import Active Listings</span></div>
            <div className="panel-body" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              <p style={{ marginBottom: 12 }}>Download from <strong style={{ color: 'var(--text-primary)' }}>eBay Seller Hub → Listings → Active → Download (.csv)</strong></p>
              <div className="form-group">
                <label className="form-label">Active Listings CSV file</label>
                <input
                  type="file"
                  accept=".csv"
                  className="form-input"
                  onChange={async e => {
                    const file = e.target.files?.[0]
                    if (!file) return
                    const text = await file.text()
                    const rows = parseCsv(text)
                    const valid = rows.filter(r => r.item_number && r.current_price)
                    setEbayActiveRows(valid)
                    addLog('success', `Parsed ${valid.length} active listings from CSV`)
                  }}
                />
              </div>
            </div>
          </div>

          {ebayActiveRows && ebayActiveRows.length > 0 && (
            <div className="panel mb-16">
              <div className="panel-header">
                <span className="panel-title">Preview — {ebayActiveRows.length} active listings</span>
              </div>
              <table className="data-table">
                <thead><tr>
                  <th>Title</th>
                  <th className="text-right">Price</th>
                  <th className="text-right">Qty</th>
                  <th>Listed</th>
                </tr></thead>
                <tbody>
                  {ebayActiveRows.slice(0, 20).map((row, i) => (
                    <tr key={i}>
                      <td className="name-cell" style={{ fontSize: 12 }}>{row.title}</td>
                      <td className="text-right text-gold">${parseFloat(row.current_price || 0).toFixed(2)}</td>
                      <td className="text-right">{row.available_quantity || 1}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{row.start_date?.split(' ')[0]}</td>
                    </tr>
                  ))}
                  {ebayActiveRows.length > 20 && (
                    <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>…and {ebayActiveRows.length - 20} more</td></tr>
                  )}
                </tbody>
              </table>
              <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end' }}>
                <button className="btn btn-primary" disabled={status === 'importing'}
                  onClick={async () => {
                    setStatus('importing'); setLogs([])
                    let created = 0, skipped = 0, errorCount = 0

                    for (const row of ebayActiveRows) {
                      const itemNum = row.item_number?.trim()
                      const title   = row.title?.trim()
                      const price   = parseFloat(row.current_price || 0)
                      if (!itemNum || !price) continue

                      // Dedup by eBay item number in notes
                      const { data: existing } = await supabase
                        .from('ebay_listings')
                        .select('id')
                        .ilike('notes', `%ebay_item:${itemNum}%`)
                        .maybeSingle()
                      if (existing) { addLog('info', `Skipped (exists): ${itemNum}`); skipped++; continue }

                      // Also check by ebay_url
                      const { data: existingUrl } = await supabase
                        .from('ebay_listings')
                        .select('id')
                        .eq('ebay_url', `https://www.ebay.com/itm/${itemNum}`)
                        .maybeSingle()
                      if (existingUrl) { addLog('info', `Skipped (exists by URL): ${itemNum}`); skipped++; continue }

                      const listedAt = row.start_date
                        ? new Date(row.start_date.replace(/-/g, ' ')).toISOString()
                        : new Date().toISOString()

                      // Match card via tcgplayer_id or card_name
                      let matchedCard = null
                      const tcgId    = row.tcgplayer_id?.trim()
                      const cardName = row.card_name?.trim()

                      if (tcgId) {
                        const { data: m } = await supabase.from('cards').select('id, quantity_listed').eq('tcgplayer_id', tcgId).eq('game_id', importGame.id).maybeSingle()
                        if (m) matchedCard = m
                      } else if (cardName) {
                        const { data: m } = await supabase.from('cards').select('id, quantity_listed').ilike('name', cardName).eq('game_id', importGame.id).maybeSingle()
                        if (m) matchedCard = m
                      }

                      const { error } = await supabase.from('ebay_listings').insert({
                        card_id:       matchedCard?.id ?? null,
                        title,
                        listed_price:  price,
                        shipping_cost: 5.00,
                        status:        'active',
                        ebay_url:      `https://www.ebay.com/itm/${itemNum}`,
                        listed_at:     listedAt,
                        notes:         `ebay_item:${itemNum}`,
                      })

                      if (error) {
                        addLog('error', `${itemNum}: ${error.message}`)
                        errorCount++; continue
                      }

                      // Increment quantity_listed if card matched
                      if (matchedCard) {
                        await supabase.from('cards').update({
                          quantity_listed: (matchedCard.quantity_listed ?? 0) + 1
                        }).eq('id', matchedCard.id)
                        addLog('info', `Matched: ${cardName || tcgId} — quantity_listed updated`)
                      } else if (tcgId || cardName) {
                        addLog('warn', `Card not found: ${cardName || tcgId}`)
                      }

                      addLog('success', `Imported: ${title} @ $${price.toFixed(2)}`)
                      created++
                    }

                    setEbayActiveSummary({ created, skipped, errorCount })
                    setStatus('done')
                  }}
                >
                  {status === 'importing' ? '⟳ Importing…' : `Import ${ebayActiveRows.length} active listings`}
                </button>
              </div>
            </div>
          )}

          {ebayActiveSummary && (
            <div className={`alert-item ${ebayActiveSummary.errorCount === 0 ? 'success' : 'warning'}`}>
              <span className="alert-icon">{ebayActiveSummary.errorCount === 0 ? '✓' : '⚠️'}</span>
              <div className="alert-content">
                <div className="alert-title">Active listings import complete</div>
                <div className="alert-desc">
                  {ebayActiveSummary.created} created · {ebayActiveSummary.skipped} skipped · {ebayActiveSummary.errorCount} errors
                </div>
              </div>
            </div>
          )}

      {/* Log — shared across all tabs */}
      {logs.length > 0 && (
        <div className="panel mt-16">
          <div className="panel-header"><span className="panel-title">Import log</span></div>
          <div style={{ padding:'12px 16px', maxHeight:300, overflowY:'auto', fontFamily:'monospace', fontSize:12 }}>
            {logs.map(log => (
              <div key={log.id} style={{ color:logColors[log.type], marginBottom:4 }}>
                [{log.type.toUpperCase()}] {log.message}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}