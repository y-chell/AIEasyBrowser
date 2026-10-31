/**
 * 只替换文本中内嵌的凭据片段，不做整串拦截。
 * 源码几乎总含 `=` 与 `&`/`;`，整串的 cookie/query 判定会把整段代码替换掉，所以源码输出只走这一步。
 */
export function redactInlineSecrets(text: string): { text: string; redacted: boolean } {
  let out = text;
  let redacted = false;

  const replace = (
    re: RegExp,
    replacement: string | ((substring: string, ...args: string[]) => string),
  ) => {
    const next = out.replace(re, replacement as Parameters<typeof String.prototype.replace>[1]);
    if (next !== out) {
      out = next;
      redacted = true;
    }
  };

  // 2. Bearer token
  replace(/\bBearer\s+([A-Za-z0-9._~+/=-]+)\b/gi, 'Bearer <redacted>');

  // 3. JWT (三段式)
  replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '<redacted_jwt>');

  // 4. URL query 参数中的敏感值
  replace(
    /(^|[?&])(access_token|refresh_token|id_token|token|api_key|apikey|password|passwd|pwd|secret|session|sid|credential|auth|oauth)=([^&#\s]+)/gi,
    (_m, p1, p2) => `${p1}${p2}=<redacted>`,
  );

  // 5. Header-like 键值对
  replace(
    /\b(authorization|cookie|set-cookie|x-api-key|api_key|apikey|password|passwd|pwd|secret|token|access_token|refresh_token|id_token|session|sid|credential|private_key|oauth)\b\s*[:=]\s*([^\s,;"']+)/gi,
    (_m, key) => `${key}=<redacted>`,
  );

  // 6. 内嵌的 Base64 数据（在混合内容中）
  replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '<redacted_base64>');

  // 7. 内嵌的长 Hex 字符串（可能是 API key、hash 等）
  replace(/\b[a-f0-9]{40,}\b/gi, '<redacted_hex>');

  return { text: out, redacted };
}
