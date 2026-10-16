import { Navigate, Route, Routes } from 'react-router'
import { lazy, Suspense } from 'react'
import { ContentBoundary } from './content/ContentBoundary'
import { Home } from '@web/src/pages/Home'
import { NotFound } from '@web/src/pages/NotFound'
import { AuthPage } from '@web/src/pages/AuthPage'
import { SsoSuccess } from '@web/src/pages/AuthPage/SsoSuccess'
import { RootLayout } from '@web/src/routes/RootLayout'
import { ProfilePage } from '@web/src/pages/ProfilePage'
import { AuthProvider } from '@web/src/auth/AuthContext'
import { InvitationRegistrationPage } from '@web/src/pages/AuthPage/InvitationRegistrationPage'
import { JoinPage } from '@web/src/pages/JoinPage/Rifling-911'
import { CAEPJoinPage } from '@web/src/pages/JoinPage/CAEP'
import { JoinResultPage } from '@web/src/pages/JoinResultPage'
import { JoinReviewPage } from '@web/src/pages/JoinReviewPage'
import { DocsPage } from '@web/src/pages/DocsPage'
import { CommunityAdminPage } from '@web/src/pages/CommunityAdminPage'
import { SignedOutPage } from '@web/src/pages/IdentityPage/SignedOutPage'
import { OidcPage } from '@web/src/pages/IdentityPage/OidcPage'
import { SupportAccess } from './routes/SupportAccess'
import { FeedbackProvider } from './pages/Support/feedback/FeedbackProvider'
const AboutUs = lazy(() => import('./pages/AboutUs/AboutUs').then(module => ({ default: module.AboutUs })))
const SupportRoutes = lazy(() => import('./pages/Support/SupportRoutes').then(module => ({ default: module.SupportRoutes })))

/**
 * 路由表：认证和 SSO 页面使用独立布局，其余页面共用站点顶栏。
 * 首版不含业务页面，因此这就是全部路由；`<BrowserRouter>` 由 `main.tsx` 提供。
 */
export function App() {
  return (
    <AuthProvider>
      <FeedbackProvider>
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<InvitationRegistrationPage />} />
        <Route path="/sso/success" element={<SsoSuccess />} />
        <Route path="/sso/*" element={<NotFound />} />
        <Route path="/identity/signed-out" element={<SignedOutPage />} />
        <Route path="/identity/login" element={<OidcPage phase="login" />} />
        <Route path="/identity/consent" element={<OidcPage phase="consent" />} />
        <Route path="/identity/logout" element={<OidcPage phase="logout" />} />
        <Route element={<RootLayout />}>
          <Route path="/" element={<Home />} />
          <Route path="/docs" element={<DocsPage />} />
          <Route path="/about" element={<Navigate to="/aboutus" replace />} />
          <Route path="/aboutus/*" element={<ContentBoundary returnUrl="/"><Suspense fallback={<p role="status" style={{ padding: '3rem' }}>正在加载介绍…</p>}><AboutUs /></Suspense></ContentBoundary>} />
          <Route path="/support/*" element={<SupportAccess><ContentBoundary returnUrl="/"><Suspense fallback={<p role="status" style={{ padding: '3rem' }}>正在加载支持中心…</p>}><SupportRoutes /></Suspense></ContentBoundary></SupportAccess>} />
          <Route path="/communities/rifling-911" element={<JoinPage />} />
          <Route path="/communities/caep" element={<CAEPJoinPage />} />
          <Route path="/join/rifling-911" element={<JoinPage />} />
          <Route path="/join/result" element={<JoinResultPage />} />
          <Route path="/admin/join-applications" element={<JoinReviewPage />} />
          <Route path="/admin/communities" element={<CommunityAdminPage />} />
          <Route path="/account/profile" element={<ProfilePage />} />
        </Route>
        <Route element={<RootLayout glassAtTop />}>
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
      </FeedbackProvider>
    </AuthProvider>
  )
}
