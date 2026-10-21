import { NavLink } from 'react-router-dom'
import { useGame } from '../context/GameContext'

const NAV = [
  {
    section: 'Overview',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: <GridIcon /> },
      { to: '/alerts', label: 'Price Alerts', icon: <BellIcon />, badge: true },
      { to: '/rules', label: 'Rules Chat', icon: <BookIcon /> },
    ],
  },
  {
    section: 'Inventory',
    items: [
      { to: '/inventory',    label: 'Cards',               icon: <CardsIcon /> },
      { to: '/listings',     label: 'eBay Listings',       icon: <TagIcon /> },
      { to: '/tcgplayer-listings', label: 'TCGPlayer Listings',  icon: <TcgIcon /> },
      { to: '/sales',        label: 'Sales',               icon: <SalesIcon /> },
      { to: '/suggestions',  label: 'Listing Suggestions', icon: <SparkleIcon /> },
      { to: '/boxes',        label: 'Boxes & P&L',         icon: <BoxIcon /> },
      { to: '/profit',       label: 'Profit',              icon: <ProfitIcon /> },
      { to: '/boxev',        label: 'Box EV',              icon: <BoxEvIcon /> },
    ],
  },
  {
    section: 'Tools',
    items: [
      { to: '/market',    label: 'Market Check', icon: <ChartIcon /> },
      { to: '/youtube',   label: 'YouTube',      icon: <YoutubeIcon /> },
      { to: '/import',    label: 'Bulk Import',  icon: <UploadIcon /> },
      { to: '/settings',  label: 'Settings',     icon: <GearIcon /> },
    ],
  },
]

export default function Sidebar({ onSignOut }) {
  const { games, activeGame, setActiveGame, alertCount } = useGame()

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <img src="/favicon.png" alt="Market Manager" className="sidebar-logo-mark" style={{ width: 40, height: 40, borderRadius: 8, objectFit: 'cover', background: 'transparent' }} />
        <div className="sidebar-logo-title">{activeGame.name}</div>
        <div className="sidebar-logo-sub">Market Manager</div>
      </div>

      {games.length > 1 && (
        <div style={{ padding: '0 16px 12px' }}>
          <select
            className="form-select"
            style={{ width: '100%', fontSize: 12 }}
            value={activeGame.id}
            onChange={e => setActiveGame(games.find(g => g.id === e.target.value))}
          >
            {games.map(g => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        </div>
      )}

      <nav className="sidebar-nav">
        {NAV.map(({ section, items }) => (
          <div key={section}>
            <div className="nav-section-label">{section}</div>
            {items.map(({ to, label, icon, badge }) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/dashboard'}
                className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
              >
                {icon}
                <span style={{ flex: 1 }}>{label}</span>
                {badge && alertCount > 0 && (
                  <span style={{
                    background: 'var(--warning)',
                    color: 'var(--bg-void)',
                    borderRadius: '10px',
                    fontSize: '10px',
                    fontWeight: 600,
                    padding: '1px 6px',
                    minWidth: '18px',
                    textAlign: 'center',
                  }}>
                    {alertCount}
                  </span>
                )}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div style={{ marginBottom: 8 }}>
          <span className="status-dot" />
          Connected to Supabase
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'center', marginBottom: 8, letterSpacing: '0.05em' }}>
          build {__GIT_HASH__}
        </div>
        <a
          href="/"
          target="_blank"
          rel="noreferrer"
          className="btn btn-ghost btn-sm"
          style={{ width: '100%', justifyContent: 'center', fontSize: 11, marginBottom: 6, textDecoration: 'none' }}
        >
          View Public Site ↗
        </a>
        <button
          className="btn btn-ghost btn-sm"
          style={{ width: '100%', justifyContent: 'center', fontSize: 11 }}
          onClick={onSignOut}
        >
          Sign out
        </button>
      </div>
    </aside>
  )
}

function GridIcon()    { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg> }
function BellIcon()    { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg> }
function CardsIcon()   { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg> }
function TagIcon()     { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg> }
function SparkleIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/></svg> }
function BoxIcon()     { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg> }
function ChartIcon()   { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> }
function GearIcon()    { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg> }
function UploadIcon()  { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> }
function YoutubeIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M22.54 6.42a2.78 2.78 0 00-1.95-1.96C18.88 4 12 4 12 4s-6.88 0-8.59.46A2.78 2.78 0 001.46 6.42 29 29 0 001 12a29 29 0 00.46 5.58A2.78 2.78 0 003.41 19.6C5.12 20 12 20 12 20s6.88 0 8.59-.46a2.78 2.78 0 001.95-1.95A29 29 0 0023 12a29 29 0 00-.46-5.58z"/><polygon points="9.75 15.02 15.5 12 9.75 8.98 9.75 15.02" fill="currentColor" stroke="none"/></svg> }
function BookIcon()  { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg> }
function BoxEvIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg> }
function TcgIcon()  { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10"/><path d="M8 12h8M12 8v8"/></svg> }
function ProfitIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/></svg> }
function SalesIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg> }