import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth.jsx';
import { ToastProvider } from './components/Toast.jsx';
import { TopBar } from './components/TopBar.jsx';
import { Sidebar } from './components/Sidebar.jsx';
import { useMediaQuery } from './util.js';
import Home from './pages/Home.jsx';
import Watch from './pages/Watch.jsx';
import Channel from './pages/Channel.jsx';
import Upload from './pages/Upload.jsx';
import Studio from './pages/Studio.jsx';
import EditVideo from './pages/EditVideo.jsx';
import Search from './pages/Search.jsx';
import { Login, Register } from './pages/Auth.jsx';
import Settings from './pages/Settings.jsx';
import { Subscriptions, Liked, History } from './pages/Library.jsx';
import Admin from './pages/Admin.jsx';
import AdminNetwork from './pages/AdminNetwork.jsx';
import AdminModeration from './pages/AdminModeration.jsx';
import AdminLegal from './pages/AdminLegal.jsx';
import { Legal, Transparency } from './pages/Legal.jsx';
import StudioComments from './pages/StudioComments.jsx';
import Editor from './pages/Editor.jsx';
import Network from './pages/Network.jsx';
import RemoteWatch from './pages/RemoteWatch.jsx';
import { Empty } from './components/VideoCard.jsx';

function Layout() {
  const location = useLocation();
  const isWatch = /^\/(watch|n|studio\/editor)\//.test(location.pathname);
  const narrow = useMediaQuery('(max-width: 792px)');
  const medium = useMediaQuery('(max-width: 1312px)');
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebar') === 'mini');
  const [drawer, setDrawer] = useState(false);

  const mode = isWatch || narrow ? 'hidden' : collapsed || medium ? 'mini' : 'full';

  const toggle = () => {
    if (mode === 'hidden') setDrawer((d) => !d);
    else {
      setCollapsed((c) => {
        localStorage.setItem('sidebar', c ? 'full' : 'mini');
        return !c;
      });
    }
  };

  useEffect(() => setDrawer(false), [location.pathname]);
  useEffect(() => {
    document.body.style.overflow = drawer ? 'hidden' : '';
  }, [drawer]);

  return (
    <>
      <TopBar onMenu={toggle} />
      {mode !== 'hidden' && <Sidebar mini={mode === 'mini'} />}
      {drawer && (
        <>
          <div className="scrim" onClick={() => setDrawer(false)} />
          <Sidebar drawer onClose={() => setDrawer(false)} />
        </>
      )}
      <main className={`main main-${mode}`}>
        <Outlet />
      </main>
    </>
  );
}

function RequireAuth({ children, admin = false, moderator = false }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="spinner" />;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  if (admin && !user.is_admin) return <Empty icon="lock" title="Admins only" />;
  if (moderator && !user.is_moderator && !user.is_admin) return <Empty icon="lock" title="Moderators only" />;
  return children;
}

function NotFound() {
  return (
    <Empty icon="warning" title="This page isn't available">
      <p>The link may be broken, or the page may have been removed.</p>
    </Empty>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<Home />} />
              <Route path="/trending" element={<Home trending />} />
              <Route path="/watch/:id" element={<Watch />} />
              <Route path="/n/:peerId/:remoteId" element={<RemoteWatch />} />
              <Route path="/network" element={<Network />} />
              <Route
                path="/studio/editor/:id"
                element={
                  <RequireAuth>
                    <Editor />
                  </RequireAuth>
                }
              />
              <Route
                path="/admin/network"
                element={
                  <RequireAuth admin>
                    <AdminNetwork />
                  </RequireAuth>
                }
              />
              <Route
                path="/admin/moderation"
                element={
                  <RequireAuth moderator>
                    <AdminModeration />
                  </RequireAuth>
                }
              />
              <Route
                path="/admin/legal"
                element={
                  <RequireAuth admin>
                    <AdminLegal />
                  </RequireAuth>
                }
              />
              <Route
                path="/studio/comments"
                element={
                  <RequireAuth>
                    <StudioComments />
                  </RequireAuth>
                }
              />
              <Route path="/legal" element={<Legal />} />
              <Route path="/transparency" element={<Transparency />} />
              <Route path="/c/:username" element={<Channel />} />
              <Route path="/results" element={<Search />} />
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />
              <Route
                path="/upload"
                element={
                  <RequireAuth>
                    <Upload />
                  </RequireAuth>
                }
              />
              <Route
                path="/studio"
                element={
                  <RequireAuth>
                    <Studio />
                  </RequireAuth>
                }
              />
              <Route
                path="/studio/edit/:id"
                element={
                  <RequireAuth>
                    <EditVideo />
                  </RequireAuth>
                }
              />
              <Route
                path="/subscriptions"
                element={
                  <RequireAuth>
                    <Subscriptions />
                  </RequireAuth>
                }
              />
              <Route
                path="/liked"
                element={
                  <RequireAuth>
                    <Liked />
                  </RequireAuth>
                }
              />
              <Route
                path="/history"
                element={
                  <RequireAuth>
                    <History />
                  </RequireAuth>
                }
              />
              <Route
                path="/settings"
                element={
                  <RequireAuth>
                    <Settings />
                  </RequireAuth>
                }
              />
              <Route
                path="/admin"
                element={
                  <RequireAuth admin>
                    <Admin />
                  </RequireAuth>
                }
              />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
