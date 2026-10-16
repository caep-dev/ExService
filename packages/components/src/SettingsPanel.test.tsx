// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SettingsPanel, type SettingsPanelProps } from '@components/src/SettingsPanel'
import type { NotificationPreferencesDraft } from '@components/src/notifications/NotificationPreferencesForm'

const cropperCallbacks = vi.hoisted(() => ({ current: null as import('react-easy-crop').CropperProps | null }))
vi.mock('react-easy-crop', () => ({
  default: (callbacks: import('react-easy-crop').CropperProps) => {
    cropperCallbacks.current = callbacks
    return <div data-testid="cropper" />
  },
}))

const profile = { email: 'person@example.com', nickname: 'Person', qq: '123',
  fivemId: 'fivem:42', avatarUrl: null }

function props(overrides: Partial<SettingsPanelProps> = {}): SettingsPanelProps {
  return {
    category: 'general', onCategoryChange: vi.fn(), theme: 'system', onThemeChange: vi.fn(),
    profile, profileStatus: 'ready', profileError: null, onRetry: vi.fn(),
    notifications: {
      identityEpoch: 1,
      preferences: { announcement: true, personal_update: true },
      status: 'ready', saving: false, conflict: false, failure: null,
      onRetryRead: vi.fn(), onSaveField: vi.fn(async (_field, draft) => draft),
    },
    onSave: vi.fn(async () => undefined), onUpload: vi.fn(async () => undefined),
    onRemoveAvatar: vi.fn(async () => undefined), onLogout: vi.fn(),
    logoutPending: false, actionPending: false, ...overrides,
  }
}

afterEach(() => { cleanup(); cropperCallbacks.current = null })

describe('SettingsPanel', () => {
  it('puts profile first while keeping the selected category controlled by its caller', () => {
    render(<SettingsPanel {...props()} />)
    const categories = screen.getByRole('navigation', { name: '设置分类' })
      .querySelectorAll('button')
    expect(Array.from(categories, (button) => button.textContent))
      .toEqual(['个人资料', '通用', '通知', '账号', '关联账户'])
    expect(screen.getByRole('button', { name: '通用' }).getAttribute('aria-current')).toBe('page')
  })

  it('shows the independent identity-links slot even when profile data failed',()=>{
    render(<SettingsPanel {...props({category:'identity-links',profile:null,profileStatus:'error',profileError:'profile unavailable',identityLinks:<p>身份关联内容</p>})}/> )
    expect(screen.getByText('身份关联内容')).toBeTruthy()
    expect(screen.queryByText('profile unavailable')).toBeNull()
  })

  it('offers mobile category selection and logout from the top menu', async () => {
    const originalScrollIntoView = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = vi.fn()
    const onCategoryChange = vi.fn()
    const onLogout = vi.fn()
    try {
      render(<SettingsPanel {...props({ category: 'profile', onCategoryChange, onLogout })} />)
      const picker = screen.getByRole('combobox', { name: '选择设置页面' })
      picker.focus()
      await userEvent.keyboard('[Space]')
      expect(screen.getByRole('option', { name: '退出登录' })).toBeTruthy()
      await userEvent.keyboard('[ArrowDown]')
      await userEvent.keyboard('[Enter]')
      expect(onCategoryChange).toHaveBeenCalledWith('general')
    } finally {
      if (originalScrollIntoView) Element.prototype.scrollIntoView = originalScrollIntoView
      else Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    }
  })

  it('shows the current profile value inside the control that opens its editor', async () => {
    render(<SettingsPanel {...props({ category: 'profile' })} />)
    const edit = screen.getByRole('button', { name: '编辑用户名' })
    expect(edit.textContent).toContain('Person')
    expect(screen.queryByText('用户名')).toBeNull()
    expect(screen.queryByRole('button', { name: '编辑QQ' })).toBeNull()
    await userEvent.click(edit)
    expect(screen.getByRole('dialog', { name: '编辑用户名' })).toBeTruthy()
  })

  it('opens avatar upload from the glass avatar and then opens the image picker', async () => {
    render(<SettingsPanel {...props({ category: 'profile' })} />)
    expect(screen.queryByText('上传头像')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '编辑头像' }))
    expect(screen.getByRole('dialog', { name: '上传头像' })).toBeTruthy()
    const imageInput = screen.getByLabelText('头像图片') as HTMLInputElement
    const openPicker = vi.spyOn(imageInput, 'click')
    await userEvent.click(screen.getByRole('button', { name: '选择图片' }))
    expect(openPicker).toHaveBeenCalledOnce()
  })

  it('offers avatar removal inside the upload dialog', async () => {
    const onRemoveAvatar = vi.fn(async () => undefined)
    render(<SettingsPanel {...props({ category: 'profile',
      profile: { ...profile, avatarUrl: '/avatar.webp' }, onRemoveAvatar })} />)
    await userEvent.click(screen.getByRole('button', { name: '编辑头像' }))
    await userEvent.click(screen.getByRole('button', { name: '移除头像' }))
    await waitFor(() => expect(onRemoveAvatar).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '上传头像' })).toBeNull())
  })

  it('changes the theme through a select without waiting for profile data', async () => {
    const originalScrollIntoView = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = vi.fn()
    const onThemeChange = vi.fn()
    try {
      render(<SettingsPanel {...props({ profile: null, profileStatus: 'loading', onThemeChange })} />)
      const theme = screen.getByRole('combobox', { name: '网站主题' })
      expect(theme.textContent).toContain('跟随系统')
      theme.focus()
      await userEvent.keyboard('[Space]')
      await userEvent.keyboard('[ArrowUp]')
      await userEvent.keyboard('[Enter]')
      expect(onThemeChange).toHaveBeenCalledWith('dark')
    } finally {
      if (originalScrollIntoView) Element.prototype.scrollIntoView = originalScrollIntoView
      else Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    }
  })

  it('groups QQ and an unverified FiveM ID under account while keeping email read-only', () => {
    render(<SettingsPanel {...props({ category: 'account' })} />)
    expect(screen.getByText('person@example.com')).toBeTruthy()
    expect(screen.getByRole('button', { name: '编辑QQ' })).toBeTruthy()
    expect(screen.getByText(/未验证。此信息由用户手填/)).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '登录邮箱' })).toBeNull()
  })

  it('keeps logout at the end of navigation and shows its failure from general settings', async () => {
    const onLogout = vi.fn()
    const onRetryAuth = vi.fn()
    render(<SettingsPanel {...props({ category: 'general', authMessage: '退出失败，请稍后重试',
      onLogout, onRetryAuth })} />)
    const navigation = screen.getByRole('navigation', { name: '设置分类' })
    expect(navigation.parentElement?.lastElementChild?.textContent).toContain('退出登录')
    expect(screen.getByRole('alert').textContent).toContain('退出失败，请稍后重试')
    await userEvent.click(screen.getByRole('button', { name: '退出登录' }))
    await userEvent.click(screen.getByRole('button', { name: '重试登录状态' }))
    expect(onLogout).toHaveBeenCalledOnce()
    expect(onRetryAuth).toHaveBeenCalledOnce()
  })

  it('validates a single QQ edit and preserves the draft after a failed save', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error('保存失败')).mockResolvedValueOnce(undefined)
    render(<SettingsPanel {...props({ category: 'account', onSave })} />)
    await userEvent.click(screen.getByRole('button', { name: '编辑QQ' }))
    const input = screen.getByRole('textbox', { name: 'QQ' })
    await userEvent.clear(input)
    await userEvent.type(input, 'invalid')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('QQ 须为 1 至 20 位数字')).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()
    await userEvent.clear(input)
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '保存失败')
    expect(input).toHaveProperty('value', '')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
    expect(onSave).toHaveBeenCalledWith('qq', '')
  })

  it('keeps the active crop preview URL alive in StrictMode and releases it on cancel', async () => {
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
    const created: string[] = []
    const revoked: string[] = []
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => {
      const url = `blob:preview-${created.length + 1}`
      created.push(url)
      return url
    } })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: (url: string) => revoked.push(url) })
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    try {
      const onUpload = vi.fn()
      render(<StrictMode><SettingsPanel {...props({ category: 'profile', onUpload })} /></StrictMode>)
      const image = new File(['image'], 'avatar.png', { type: 'image/png' })
      await userEvent.click(screen.getByRole('button', { name: '编辑头像' }))
      await userEvent.upload(screen.getByLabelText('头像图片'), image)
      expect(await screen.findByRole('heading', { name: '裁剪头像' })).toBeTruthy()
      expect(screen.queryByRole('dialog', { name: '上传头像' })).toBeNull()
      expect(created.length).toBeGreaterThan(0)
      expect(revoked).not.toContain(created.at(-1))
      await userEvent.click(screen.getByRole('button', { name: '取消' }))
      expect(revoked).toContain(created.at(-1))
      expect(onUpload).not.toHaveBeenCalled()
    } finally {
      if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate)
      else Reflect.deleteProperty(URL, 'createObjectURL')
      if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke)
      else Reflect.deleteProperty(URL, 'revokeObjectURL')
      vi.unstubAllGlobals()
    }
  })

  it('keeps canonical notification values across a category round trip without saving again', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    try {
      const input = props({ category: 'notifications' })
      const view = render(<SettingsPanel {...input} />)
      await userEvent.click(screen.getByRole('switch', { name: '社区动态' }))
      expect(input.notifications.onSaveField).toHaveBeenCalledTimes(1)
      // 字段意图与整份已校验值一起交给 module，revision 与另一字段不在 Form 里。
      expect(input.notifications.onSaveField).toHaveBeenCalledWith('announcement',
        { announcement: false, personal_update: true })
      expect(screen.queryByText(/已保存/)).toBeNull()

      view.rerender(<SettingsPanel {...input} category="profile" />)
      expect(screen.getByRole('button', { name: '编辑用户名' })).toBeTruthy()
      // 表单仍在组件树里，只是不渲染任何内容。
      expect(screen.queryByRole('switch', { name: '社区动态' })).toBeNull()

      view.rerender(<SettingsPanel {...input} category="notifications" />)
      expect((screen.getByRole('switch', { name: '社区动态' }) as HTMLButtonElement)
        .getAttribute('aria-checked')).toBe('false')
      expect(input.notifications.onSaveField).toHaveBeenCalledTimes(1)
      expect(screen.queryByText(/已保存/)).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.each(['general', 'profile', 'account'] as const)(
    'shows no notification form content and writes nothing while %s is selected', async category => {
      vi.stubGlobal('ResizeObserver', class {
        observe() {}
        unobserve() {}
        disconnect() {}
      })
      try {
        const input = props({ category,
          notifications: {
            identityEpoch: 1, preferences: { announcement: true, personal_update: true },
            status: 'ready', saving: false, conflict: false,
            failure: { id: 3, retryValues: { announcement: false, personal_update: true },
              onRetrySave: vi.fn(async (values) => values) },
            onRetryRead: vi.fn(), onSaveField: vi.fn(async (_field, draft) => draft),
          } })
        render(<SettingsPanel {...input} />)
        // 非通知分类不展示开关、错误或加载态，也不自动写入。
        expect(screen.queryByRole('switch', { name: '社区动态' })).toBeNull()
        expect(screen.queryByRole('switch', { name: '个人提醒' })).toBeNull()
        expect(screen.queryByRole('button', { name: '重试保存' })).toBeNull()
        expect(screen.queryByLabelText('正在加载通知设置')).toBeNull()
        expect(screen.queryByText('管理站内通知。关闭可选分类只影响未来接收，已有通知保留。')).toBeNull()
        expect(input.notifications.onSaveField).not.toHaveBeenCalled()
        expect(input.notifications.onRetryRead).not.toHaveBeenCalled()
      } finally {
        vi.unstubAllGlobals()
      }
    })

  it('keeps the same form owner across a category round trip for the notifications slice', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    try {
      let release!: (value: NotificationPreferencesDraft) => void
      const onSaveField = vi.fn(() => new Promise<NotificationPreferencesDraft>(resolve => { release = resolve }))
      const input = props({ category: 'notifications',
        notifications: {
          identityEpoch: 4, preferences: { announcement: false, personal_update: true },
          status: 'ready', saving: false, conflict: false, failure: null,
          onRetryRead: vi.fn(), onSaveField,
        } })
      const view = render(<SettingsPanel {...input} />)
      expect(screen.getByRole('switch', { name: '社区动态' }).getAttribute('aria-checked')).toBe('false')
      await userEvent.click(screen.getByRole('switch', { name: '社区动态' }))
      expect(onSaveField).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('status').textContent).toBe('保存中…')
      view.rerender(<SettingsPanel {...input} category="general" />)
      expect(screen.queryByRole('status')).toBeNull()
      // 切走再回来沿用同一个 RHF 所有者：在途提交状态没有被重建或取消。
      view.rerender(<SettingsPanel {...input} category="notifications" />)
      expect(screen.getByRole('status').textContent).toBe('保存中…')
      await act(async () => { release({ announcement: true, personal_update: true }) })
      expect(screen.queryByRole('status')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('renders the notification section without waiting for the profile source', () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    try {
      // 通知分区只看通知来源：资料加载中或失败都不能让它跟着转圈或报错。
      render(<SettingsPanel {...props({
        category: 'notifications', profileStatus: 'loading', profile: null,
      })} />)
      expect(screen.getByText('管理站内通知。关闭可选分类只影响未来接收，已有通知保留。')).toBeTruthy()
      expect(screen.queryByRole('heading', { name: '个人资料' })).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('updates the crop zoom limit when the cropper recalculates media size on resize', async () => {
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:preview' })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined })
    try {
      render(<SettingsPanel {...props({ category: 'profile' })} />)
      await userEvent.click(screen.getByRole('button', { name: '编辑头像' }))
      await userEvent.upload(screen.getByLabelText('头像图片'),
        new File(['image'], 'avatar.png', { type: 'image/png' }))
      expect(await screen.findByTestId('cropper')).toBeTruthy()
      const callbacks = cropperCallbacks.current
      expect(callbacks?.setMediaSize).toBeTypeOf('function')
      expect(callbacks?.setCropSize).toBeTypeOf('function')
      act(() => {
        callbacks?.setMediaSize?.({ width: 160, height: 160, naturalWidth: 512, naturalHeight: 512 })
        callbacks?.setCropSize?.({ width: 320, height: 320 })
      })
      expect(screen.getByRole('slider', { name: '缩放' }).getAttribute('min')).toBe('2')
      act(() => {
        callbacks?.setMediaSize?.({ width: 320, height: 320, naturalWidth: 512, naturalHeight: 512 })
        callbacks?.setCropSize?.({ width: 320, height: 320 })
      })
      expect(screen.getByRole('slider', { name: '缩放' }).getAttribute('min')).toBe('1')
    } finally {
      if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate)
      else Reflect.deleteProperty(URL, 'createObjectURL')
      if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke)
      else Reflect.deleteProperty(URL, 'revokeObjectURL')
    }
  })
})
