import { performance } from 'node:perf_hooks'

/** Redacts even short and percent-encoded secrets; never prints raw connection URLs or SQL. */
export function redact(value, environment = {}) {
  let text = String(value).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  const secrets = new Set()
  for (const [key, value] of Object.entries(environment)) {
    if (!value) continue
    if (/(?:PASSWORD|SECRET|TOKEN|KEY|DSN|DATABASE_URL|REDIS_URL|OUTBOX_TARGETS_JSON|IDENTITY_CLIENTS_JSON)/i.test(key)) {
      secrets.add(value)
      secrets.add(encodeURIComponent(value))
      secrets.add(JSON.stringify(value).slice(1, -1))
      try {
        const url = new URL(value)
        if (url.password) {
          secrets.add(url.password)
          secrets.add(decodeURIComponent(url.password))
        }
      } catch {}
      if (['IDENTITY_CLIENTS_JSON', 'IDENTITY_OUTBOX_TARGETS_JSON'].includes(key)) {
        const collect = item => {
          if (!item || typeof item !== 'object') return
          for (const [field, nested] of Object.entries(item)) {
            if (['clientSecret', 'integrationKey', 'key', 'deliveryKey'].includes(field) && typeof nested === 'string' && nested) {
              secrets.add(nested); secrets.add(encodeURIComponent(nested)); secrets.add(JSON.stringify(nested).slice(1, -1))
            } else collect(nested)
          }
        }
        try { collect(JSON.parse(value)) } catch {}
      }
    }
  }
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.split(secret).join('[已隐藏]')
  return text.replace(/\bBearer\s+\S+/gi, 'Bearer [已隐藏]')
    .replace(/(?:postgres(?:ql)?|rediss?):\/\/[^\s'"<>]+/gi, '[连接串已隐藏]')
    .replace(/\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|ALTER|CREATE|DROP|TRUNCATE)\b[^\r\n]*/gi, '[SQL 已隐藏]')
}

const advice = {
  DOCKER_NOT_FOUND: ['找不到 docker 命令', '安装 Docker 并确认 docker 位于 PATH'],
  DOCKER_UNAVAILABLE: ['无法连接 Docker 引擎', '检查 docker info、Docker Desktop/daemon 和当前 context'],
  DOCKER_COMMAND_TIMEOUT: ['Docker 调用超时', '检查 Docker Desktop/daemon 是否响应'],
  ENV_INVALID: ['根环境文件无法读取或解析', '修正根 .env.local 的权限和 dotenv 格式'],
  CONFIG_REQUIRED: ['必需配置缺失或格式无效', '在根 .env.local 填写上方配置键；已有环境保留原值'],
  PROFILE_INVALID: ['运行配置类型无效', '本地开发设置 RUNTIME_PROFILE=local；原生运行使用 deployment'],
  PORT_INVALID: ['端口不是有效整数', '将上方端口设置为 1024–65535 的整数'],
  PORT_CONFLICT: ['本地服务端口重复', '给上方服务配置互不重复的端口'],
  PRIVATE_LISTENER_REQUIRED: ['应用监听地址不是回环地址', '将上方监听地址设置为 127.0.0.1'],
  URL_INVALID: ['服务地址格式无效', '核对上方地址的协议、主机和端口；本地使用 http://127.0.0.1:<端口>'],
  CRYPTO_KEY_INVALID: ['密钥格式无效', '上方密钥必须为 64 位 hex；保留已有环境的原密钥'],
  DATABASE_HOST_INVALID: ['数据库主机格式无效', '填写数据库主机名或 IP，不要填写连接 URL'],
  DATABASE_TLS_INVALID: ['数据库 TLS 模式无效', '使用 disable、allow、prefer、require、verify-ca 或 verify-full'],
  DATABASE_IDENTITY_CONFLICT: ['数据库名称或连接身份与预期不一致', '核对该服务的数据库名和独立 owner；Website=exre，Hydra=hydra'],
  DATABASE_OWNER_CONFLICT: ['数据库 owner 或角色权限冲突', '核对现有库的独立 owner、登录权限和原凭据；文档 owner 不得使用管理员或 Website owner'],
  DATABASE_MIGRATIONS_MISSING: ['数据库 migration 未完成', '对现有 Hydra 显式执行 pnpm infra migrate'],
  DATABASE_STRUCTURE_INCOMPLETE: ['数据库必需表或列缺失', '对现有 Hydra 显式执行 pnpm infra migrate；被手工修改的结构先核对迁移记录'],
  BUILD_ARTIFACT_MISSING: ['应用构建产物缺失', '执行 pnpm build 后重试'],
  HYDRA_BINARY_REQUIRED: ['原生 Hydra 可执行文件缺失', '安装 Hydra v2.3.0，并将 HYDRA_BINARY 指向可执行文件'],
  HYDRA_CLIENT_MISSING: ['Hydra OIDC client 尚未登记', '核对 IDENTITY_CLIENTS_JSON 后显式执行 pnpm infra clients'],
  HYDRA_CLIENT_CONFLICT: ['Hydra OIDC client 配置不一致', '核对 issuer、回调地址和 IDENTITY_CLIENTS_JSON 与现有 client；不要自动覆盖身份配置'],
  HYDRA_CONFIG_INVALID: ['Hydra OIDC 连接配置无效', '核对 HYDRA_ADMIN_URL、HYDRA_PUBLIC_URL、PUBLIC_ORIGIN 和 IDENTITY_CLIENTS_JSON'],
  HYDRA_CLIENT_CHECK_FAILED: ['Hydra OIDC client 检查失败', '检查 pnpm service:status、pnpm service:logs hydra 和 Hydra admin/public 地址'],
  WEBSITE_NOT_READY: ['Website 启动检查未通过', '按上方 Website 检查项修正对应配置或迁移后重试'],
  APPLICATION_NOT_READY: ['应用 HTTP 健康检查未通过', '核对上方服务地址、监听端口和进程日志'],
  APP_EXITED_DURING_START: ['应用在启动期间退出', '检查上方退出进程的错误日志，修正后重试'],
  APPLICATION_PORT_OCCUPIED: ['应用端口已被占用', '检查对应端口的监听进程；停止已知应用或显式调整本项目端口'],
  LOCAL_PROFILE_REQUIRED: ['命令要求本地运行配置', '设置 RUNTIME_PROFILE=local 后重试'],
  DEPLOYMENT_PROFILE_REQUIRED: ['命令要求原生运行配置', '本地开发使用 pnpm dev；原生运行设置 RUNTIME_PROFILE=deployment'],
  BOOTSTRAP_UUID_REQUIRED: ['缺少有效管理员账号 UUID', '选择已有 active Website 账号，传入 --admin-user-id <UUID>'],
}

export class RuntimeError extends Error {
  constructor(code, { service = '运行配置', phase = '校验', keys = [], target = '', reason, next } = {}) {
    const hint = advice[code]
    reason ??= hint?.[0] ?? (/CONFLICT|OWNERSHIP|PROOF|INVENTORY/.test(code) ? '资源配置或归属核验未通过' : '检查项未通过')
    next ??= hint?.[1] ?? (/CONFLICT|OWNERSHIP|PROOF|INVENTORY/.test(code)
      ? '核对当前配置和资源归属，保留现有数据；不要删除归属记录绕过检查'
      : '核对上方服务、阶段和配置键，修正失败项后重试')
    super(`${service} · ${phase} · ${code}（${reason}）${target ? ` · ${target}` : ''}${keys.length ? ` · 配置键 ${keys.join(', ')}` : ''}；下一步：${next}`)
    this.code = code
    Object.assign(this, { service, phase, keys, target, reason, next })
  }
}

/** Render only trusted runtime errors or safe codes; unknown exception messages stay hidden. */
export function runtimeFailure(error) {
  if (error instanceof RuntimeError) return error.message
  if (/^[A-Z][A-Z0-9_]+$/.test(error?.code ?? '')) return new RuntimeError(error.code).message
  return '运行失败：未分类异常；请检查上方服务日志中的失败项；原始异常已隐藏'
}

/** Keeps failure classification separate from database readiness checks. */
export function diagnostic(error, context) {
  if (error instanceof RuntimeError) return error
  const nested = error?.cause?.code ?? error?.errors?.[0]?.code
  const code = error?.code ?? nested
  const reasons = { ECONNREFUSED: '连接被拒绝', ENOTFOUND: 'DNS 解析失败', EAI_AGAIN: 'DNS 暂时不可用',
    ETIMEDOUT: '连接超时', ECONNRESET: '连接中断', '28P01': '密码错误', '28000': '认证失败',
    '3D000': '数据库不存在', '42P01': 'migration 或必需表缺失', '42703': 'migration 或必需列缺失' }
  return new RuntimeError(`${code ?? 'CHECK_FAILED'} (${reasons[code] ?? '检查失败'})`, context)
}

/** Color is terminal-only; persisted output is always redacted plain text. */
export function reporter({ environment = {}, verbose = false, stream = process.stdout, colorEnvironment = process.env,
  write = line => console.log(line), persist } = {}) {
  const color = Boolean(stream.isTTY) && !colorEnvironment.NO_COLOR && colorEnvironment.TERM !== 'dumb' && colorEnvironment.FORCE_COLOR !== '0'
  const safe = value => redact(value, environment)
  const styles = { bold: 1, gray: 90, cyan: 36, success: 32, warning: 33, error: 31 }
  const paint = (value, style) => color ? `\x1b[${styles[style]}m${value}\x1b[0m` : value
  // Simulator payloads contain live codes: retain only the channel marker, even in stage failure output.
  const hideDevelopmentMail = value => String(value).replace(/\[registration-mail:development\][^\r\n]*/g,
    '[registration-mail:development] [测试邮件内容已隐藏]')
  const showDevelopmentMail = Boolean(stream.isTTY) && environment.SERVER_REGISTRATION_MAIL_SIMULATOR === 'true'
  const emit = (plain, displayed = plain, retained = plain) => {
    persist?.(safe(hideDevelopmentMail(retained)))
    write(showDevelopmentMail ? displayed : hideDevelopmentMail(displayed))
  }
  const title = value => { const text = safe(value); emit(text, paint(text, 'bold')) }
  const log = (service, line, level = '信息') => {
    const now = new Date(), name = safe(service), text = safe(line)
    // stderr is a transport channel, not proof of an error (many tools use it for progress).
    if (['stdout', 'stderr'].includes(level)) level = '信息'
    let severity
    try { severity = JSON.parse(text).level } catch {}
    const prefix = text.replace(/^(?:\[[^\]]+\]\s*)+/, '')
    const tone = /^(?:错误|error|fatal)$/i.test(level) || severity >= 50 || /^(?:错误|error|fatal)(?:[:\s]|$)/i.test(prefix) ? 'error'
      : /^(?:警告|warn|warning)$/i.test(level) || severity >= 40 || /^(?:警告|warn(?:ing)?)(?:[:\s]|$)/i.test(prefix)
        || /DeprecationWarning|deprecated/i.test(text) ? 'warning' : 'cyan'
    const time = verbose ? now.toISOString() : now.toTimeString().slice(0, 8)
    const plain = `${time} [${name}] ${text}`
    emit(plain, `${paint(time, 'gray')} ${paint(`[${name}]`, tone)} ${text}`, `${now.toISOString()} [${level}] [${name}] ${text}`)
  }
  const status = (service, state, detail = '', { level = 'warning', detailTone = 'cyan' } = {}) => {
    const symbol = { success: '✓', warning: '!', error: '✗', gray: '·' }[level] ?? '·'
    const name = safe(service).padEnd(10), label = safe(state), suffix = detail ? `  ${safe(detail)}` : ''
    emit(`  ${symbol} ${name}  ${label}${suffix}`,
      `  ${paint(symbol, level)} ${name}  ${paint(label, level)}${paint(suffix, detailTone)}`)
  }
  const next = (value, commands = []) => {
    emit(''); title('下一步')
    for (const line of safe(value).split(/；|\n/).filter(Boolean)) emit(`  ${line}`, `  ${paint(line, 'cyan')}`)
    if (commands.length) {
      emit(''); title('其他操作')
      for (const [label, command] of commands) {
        const name = safe(label), action = safe(command)
        emit(`  ${name}  ${action}`, `  ${paint(name, 'gray')}  ${paint(action, 'cyan')}`)
      }
    }
  }
  const success = value => { const text = `✓ ${safe(value)}`; emit(''); emit(text, paint(text, 'success')) }
  return { log, title, status, next, success,
    heading(value) { emit(''); title(value); emit('') },
    note(value) { for (const line of safe(value).split('\n')) emit(`  ${line}`, paint(`  ${line}`, 'gray')) },
    failure(error) {
      const failure = error instanceof RuntimeError ? error : /^[A-Z][A-Z0-9_]+$/.test(error?.code ?? '') ? new RuntimeError(error.code) : null
      const reason = failure ? `${failure.reason.startsWith(failure.service) ? '' : `${failure.service} `}${failure.reason}` : '运行失败'
      const text = `✗ ${safe(reason)}`
      emit(''); emit(text, paint(text, 'error')); emit('')
      const fields = failure ? [['检查项', failure.phase], ['错误码', failure.code], ['目标', failure.target], ['配置键', failure.keys.join(', ')]]
        : [['原因', '未分类异常，原始消息已隐藏']]
      for (const [label, value] of fields) if (value) {
        const line = `  ${label}  ${safe(value)}`; emit(line, paint(line, 'gray'))
      }
      next(failure?.next ?? '请检查上方服务日志中的失败项')
    },
    async stage(service, execute) {
      const start = performance.now(), lines = []
      log(service, '开始')
      try {
        const result = await execute((name, line, channel) => {
          const safe = redact(line, environment)
          if (verbose || channel === 'stderr' || /warn|error|警告|错误|deprecated/i.test(safe)) log(name, safe)
          lines.push(`[${name}] ${safe}`)
          if (lines.length > 300) lines.shift()
        })
        log(service, `完成 (${((performance.now() - start) / 1000).toFixed(1)} 秒)`)
        return result
      } catch (error) {
        lines.forEach(line => emit(line))
        log(service, error instanceof RuntimeError ? error.message : '阶段失败；检查上方日志', '错误')
        throw error
      }
    },
  }
}
