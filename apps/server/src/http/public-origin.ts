/** Validate the configured Website root without depending on any retired business flow. */
export function publicWebBaseUrl(value = 'http://localhost:8081'):string {
  let url:URL;
  try {url=new URL(value)} catch {throw new Error('SERVER_PUBLIC_WEB_BASE_URL 必须是完整 HTTP(S) 站点根地址。')}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')
    throw new Error('SERVER_PUBLIC_WEB_BASE_URL 必须是无凭据、query、hash 的 HTTP(S) 站点根地址。');
  return url.origin;
}
