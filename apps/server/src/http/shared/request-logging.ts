import type { FastifyServerOptions } from 'fastify'

/** Installed at construction, before Fastify's automatic incoming-request log. */
export function safeRequestLogger(logger: FastifyServerOptions['logger']): FastifyServerOptions['logger'] {
  if (logger === false || logger === undefined) return false
  const options = logger === true ? {} : logger
  return { ...options, serializers: { ...options.serializers,
    req(value: { id?: string; method?: string; url?: string }) {
      let pathname = '[invalid-path]'
      try { pathname = new URL(value.url ?? '', 'http://request.invalid').pathname } catch { /* never log the raw URL */ }
      return { id: value.id, method: value.method, pathname }
    },
    res(value: { statusCode?: number }) { return { statusCode: value.statusCode } },
    err() { return { type: 'Error', message: 'Request failed.', stack: '' } },
  } }
}
