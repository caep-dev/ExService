import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@exre/exui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@exre/exui')>()),
  useTheme: () => ({ theme: 'dark' }),
}))

vi.mock('@workspace/components', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@workspace/components')>()),
  SiteHeader: () => <header>Site header</header>,
}))

vi.mock('@web/src/pages/Home', () => ({
  Home: () => <main>Home</main>,
}))

vi.mock('@web/src/pages/NotFound', () => ({
  NotFound: () => <main>Page not found</main>,
}))

vi.mock('@web/src/pages/AuthPage/SsoSuccess', () => ({
  SsoSuccess: () => <main>SSO success</main>,
}))

import { App } from '@web/src/App'

describe('auth routes', () => {
  it.each([['/login', '登录到 Exre'], ['/register', '注册 Exre 账号']])('renders %s without the site navbar', (path, title) => {
    const markup = renderToStaticMarkup(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    )

    expect(markup).not.toContain('<header')
    expect(markup).toContain(title)
    expect(markup).toContain('href="/"')
    expect(markup).toContain('Home')
    expect(markup).toContain('By signing up, you agree to our Terms, Acceptable Use, and Privacy Policy.')
    expect(markup).not.toContain('Page not found')
  })

  it.each([`/login?ssoRequestId=${'a'.repeat(43)}`, '/login?ssoRequestId=invalid'])('hides Home on an SSO entry: %s', (path) => {
    const markup = renderToStaticMarkup(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    )

    expect(markup).not.toContain('Home</a>')
  })

  it.each([['/sso/success', 'SSO success'], ['/sso/unknown', 'Page not found']])('renders %s without the site navbar', (path, content) => {
    const markup = renderToStaticMarkup(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    )

    expect(markup).toContain(content)
    expect(markup).not.toContain('<header')
  })
})
