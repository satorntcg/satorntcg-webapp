import { Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { supabase } from './lib/supabase'
import { GameProvider } from './context/GameContext'
import Sidebar from './components/Sidebar'
import PublicNav from './components/PublicNav'
import Dashboard from './pages/Dashboard'
import Inventory from './pages/Inventory'
import Alerts from './pages/Alerts'
import EbayListings from './pages/Ebaylistings'
import TcgplayerListings from './pages/Tcgplayerlistings'
import Sales from './pages/Sales'
import Boxes from './pages/Boxes'
import Profit from './pages/Profit'
import Market from './pages/Market'
import Settings from './pages/Settings'
import Import from './pages/Import'
import Login from './pages/Login'
import YouTube from './pages/YouTube'
import ListingSuggestions from './pages/Listingsuggestions'
import RulesChat from './pages/RulesChat'
import Home from './pages/Home'
import PublicCards from './pages/PublicCards'
import CardDetail from './pages/CardDetail'
import Contact from './pages/Contact'
import PublicVideos from './pages/PublicVideos'
import BoxEV from './pages/BoxEV'

// Short public redirect paths — no auth gate, no page flash. Add new ones here.
const PUBLIC_REDIRECTS = {
  '/tcgplayer':      'https://www.tcgplayer.com/sellers/SatornTCG/f0dfddc3',
  '/ebay':           'https://www.ebay.com/str/satorntcg',
}

function ExternalRedirect({ to }) {
  useEffect(() => { window.location.replace(to) }, [to])
  return null
}

function PublicLayout({ session }) {
  return (
    <>
      <PublicNav session={session} />
      <Outlet />
    </>
  )
}

function PrivateGuard({ session }) {
  if (session === undefined) return <div className="loading" style={{ height: '100vh' }}>Loading…</div>
  if (!session) return <Navigate to="/login" replace />
  return <Outlet />
}

function PrivateLayout() {
  return (
    <GameProvider>
      <div className="app-shell">
        <Sidebar onSignOut={() => supabase.auth.signOut()} />
        <main className="main-content">
          <Outlet />
        </main>
      </div>
    </GameProvider>
  )
}

export default function App() {
  const [session, setSession] = useState(undefined)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session))
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })
    return () => subscription.unsubscribe()
  }, [])

  return (
    <Routes>
      {/* External redirects — bypass auth entirely, resolve before any UI renders */}
      {Object.entries(PUBLIC_REDIRECTS).map(([path, url]) => (
        <Route key={path} path={path} element={<ExternalRedirect to={url} />} />
      ))}

      {/* Public routes — no auth required */}
      <Route element={<PublicLayout session={session} />}>
        <Route path="/"          element={<Home />} />
        <Route path="/cards"     element={<PublicCards />} />
        <Route path="/cards/:slug/:id" element={<CardDetail />} />
        <Route path="/rules"     element={<RulesChat />} />
        <Route path="/videos"    element={<PublicVideos />} />
        <Route path="/contact"   element={<Contact />} />
      </Route>

      {/* Login — redirect to dashboard if already signed in */}
      <Route path="/login" element={
        session === undefined
          ? <div className="loading" style={{ height: '100vh' }}>Loading…</div>
          : session
          ? <Navigate to="/dashboard" replace />
          : <Login />
      } />

      {/* Private routes — require auth, render with sidebar */}
      <Route element={<PrivateGuard session={session} />}>
        <Route element={<PrivateLayout />}>
          <Route path="/dashboard"   element={<Dashboard />} />
          <Route path="/inventory"   element={<Inventory />} />
          <Route path="/alerts"      element={<Alerts />} />
          <Route path="/listings"    element={<EbayListings />} />
          <Route path="/tcgplayer-listings" element={<TcgplayerListings />} />
          <Route path="/sales"       element={<Sales />} />
          <Route path="/boxes"       element={<Boxes />} />
          <Route path="/profit"      element={<Profit />} />
          <Route path="/market"      element={<Market />} />
          <Route path="/youtube"     element={<YouTube />} />
          <Route path="/import"      element={<Import />} />
          <Route path="/settings"    element={<Settings />} />
          <Route path="/suggestions" element={<ListingSuggestions />} />
          <Route path="/boxev"       element={<BoxEV />} />
          <Route path="*"            element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Route>
    </Routes>
  )
}
