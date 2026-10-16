// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef, type Ref } from 'react'
import { AuthForm, type AuthFormHandle, type AuthFormProps } from '@components/src/auth/AuthForm'

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', TestResizeObserver)
Object.defineProperty(document, 'elementFromPoint', {
  configurable: true,
  value: () => document.body,
})

afterEach(cleanup)

function renderForm(overrides: Partial<AuthFormProps> = {}, ref?: Ref<AuthFormHandle>) {
  const props: AuthFormProps = {
    step: 'credentials',
    busy: false,
    onContinueLogin: vi.fn(),
    onCaptchaSubmit: vi.fn(),
    onJoin: vi.fn(),
    ...overrides,
  }
  return { props, ...render(<AuthForm {...props} ref={ref} />) }
}

describe('AuthForm', () => {
  it('shows the placeholder captcha step and allows an empty answer', async () => {
    const user = userEvent.setup()
    const { props, container } = renderForm({ step: 'captcha' })
    expect(screen.getByRole('heading', { name: '输入验证码' })).toBeTruthy()
    expect(container.querySelector('.ex-glass')).toBeTruthy()
    const image = screen.getByRole('img', { name: '验证码图片占位区域' })
    expect(image.parentElement?.contains(screen.getByRole('textbox', { name: '图片验证码' }))).toBe(true)
    expect(screen.queryByText('完成后点击登录。')).toBeNull()
    expect(screen.getByText('验证码功能开发中，当前输入不校验；留空也可继续。')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '登录' }))
    expect(props.onCaptchaSubmit).toHaveBeenCalledWith('')
    expect(screen.queryByRole('button', { name: '返回修改资料' })).toBeNull()
  })

  it('reserves disabled providers and routes account registration through its callback', async () => {
    const user = userEvent.setup()
    const { props } = renderForm({})
    expect((screen.getByRole('button', { name: 'Google 暂未开放' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'QQ 暂未开放' }) as HTMLButtonElement).disabled).toBe(true)
    await user.type(screen.getByLabelText('邮箱'), 'member@example.com')
    await user.click(screen.getByRole('button', { name: '注册账号' }))
    expect(props.onJoin).toHaveBeenCalledOnce()
    expect(props.onContinueLogin).not.toHaveBeenCalled()
  })

  it('validates login credentials and submits through the existing callback', async () => {
    const user = userEvent.setup()
    const { props } = renderForm({})
    await user.click(screen.getByRole('button', { name: '继续' }))
    expect(await screen.findByText('请输入有效的邮箱地址')).toBeTruthy()
    expect(props.onContinueLogin).not.toHaveBeenCalled()
    await user.type(screen.getByLabelText('邮箱'), 'member@example.com')
    await user.type(screen.getByLabelText('密码', { exact: true }), 'password-one')
    await user.click(screen.getByRole('button', { name: '继续' }))
    expect(props.onContinueLogin).toHaveBeenCalledWith({ email: 'member@example.com', password: 'password-one' })
  })

  it('focuses the email input', () => {
    renderForm()
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '邮箱' }))
  })

  it('shows server login errors and disables submission while busy', () => {
    const formRef = createRef<AuthFormHandle>()
    const rendered = renderForm({}, formRef)
    act(() => formRef.current?.setServerErrors({ password: '密码错误', form: '登录失败' }))
    expect(screen.getByText('密码错误')).toBeTruthy()
    expect(screen.getByText('登录失败').closest('[role="alert"]')).toBeTruthy()
    rendered.rerender(<AuthForm {...rendered.props} busy />)
    expect((screen.getByRole('button', { name: '处理中' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('密码', { exact: true }) as HTMLInputElement).disabled).toBe(true)
  })

  it('clears a server field error when the next login attempt begins', async () => {
    const user = userEvent.setup()
    const formRef = createRef<AuthFormHandle>()
    const rendered = renderForm({}, formRef)
    act(() => formRef.current?.setServerErrors({ email: '邮箱暂时不可用' }))
    expect(screen.getByText('邮箱暂时不可用')).toBeTruthy()

    act(() => formRef.current?.clearServerErrors())
    expect(screen.queryByText('邮箱暂时不可用')).toBeNull()

    await user.type(screen.getByLabelText('邮箱'), 'member@example.com')
    await user.type(screen.getByLabelText('密码', { exact: true }), 'password-one')
    await user.click(screen.getByRole('button', { name: '继续' }))
    expect(rendered.props.onContinueLogin).toHaveBeenCalledWith({ email: 'member@example.com', password: 'password-one' })
  })

  it('keeps a service error in React Hook Form after asynchronous login completes', async () => {
    const user = userEvent.setup()
    const formRef = createRef<AuthFormHandle>()
    renderForm({ onContinueLogin: () => {
      formRef.current?.setServerErrors({ form: '登录服务暂时不可用' })
    } }, formRef)

    await user.type(screen.getByLabelText('邮箱'), 'member@example.com')
    await user.type(screen.getByLabelText('密码', { exact: true }), 'password-one')
    await user.click(screen.getByRole('button', { name: '继续' }))

    expect(await screen.findByText('登录服务暂时不可用')).toBeTruthy()
    expect((screen.getByRole('button', { name: '继续' }) as HTMLButtonElement).disabled).toBe(false)
  })

})
