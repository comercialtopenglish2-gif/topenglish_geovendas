// Login e sessão via API do Top English CMS (docs/INTEGRACAO_API_FRONT.md).
// O JWT do CMS fica só no cookie HttpOnly `gv_session`. Nunca é logado nem exposto ao JavaScript do navegador.
import crypto from "node:crypto";

const CMS = () => (process.env.CMS_BASE_URL || "https://cms.topenglish.com.br").replace(/\/+$/, "");
const PROD = () => process.env.NODE_ENV === "production";
export const COOKIE = "gv_session";
const TTL_CACHE_MS = Number(process.env.AUTH_CACHE_MS || 60 * 1000);
const TIMEOUT_MS = 8000;

// ---------- cookies ----------
export function lerCookie(req, nome) {
  const h = req.headers.cookie || "";
  for (const parte of h.split(";")) {
    const i = parte.indexOf("=");
    if (i > 0 && parte.slice(0, i).trim() === nome) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return null;
}
export function gravarSessao(res, token, horas) {
  const maxAge = Math.max(60, Math.round((Number(horas) || 24) * 3600));
  res.append("Set-Cookie", `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; ${PROD() ? "Secure; " : ""}SameSite=Lax; Path=/; Max-Age=${maxAge}`);
}
export function apagarSessao(res) {
  res.append("Set-Cookie", `${COOKIE}=; HttpOnly; ${PROD() ? "Secure; " : ""}SameSite=Lax; Path=/; Max-Age=0`);
}

// ---------- chamada ao CMS ----------
async function cms(caminho, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(CMS() + caminho, {
      ...opts, signal: ctl.signal,
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(opts.headers || {}) },
    });
    let corpo = null; try { corpo = await r.json(); } catch {}
    return { status: r.status, corpo };
  } finally { clearTimeout(t); }
}

// ---------- limite de tentativas (memória) ----------
const tentativas = new Map(); // chave -> [timestamps]
const JANELA = 15 * 60 * 1000, MAX_TENT = 10;
export function bloqueadoPorTentativas(ip, email) {
  const k = ip + "|" + String(email || "").trim().toLowerCase();
  const agora = Date.now();
  const lista = (tentativas.get(k) || []).filter(t => agora - t < JANELA);
  lista.push(agora); tentativas.set(k, lista);
  if (tentativas.size > 5000) for (const [kk, v] of tentativas) if (!v.some(t => agora - t < JANELA)) tentativas.delete(kk);
  return lista.length > MAX_TENT;
}

// POST {CMS}/admin/auth/login. Devolve { ok, token, horas, user, unit } ou { ok:false, status, message }
export async function loginCms(email, password) {
  let r;
  try { r = await cms("/admin/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }); }
  catch { return { ok: false, status: 502, message: "Não consegui falar com o sistema da Top English agora. Tente novamente." }; }
  if (r.status === 200 && r.corpo && r.corpo.token) {
    return { ok: true, token: r.corpo.token, horas: r.corpo.expires_in_hours || 24, user: r.corpo.user, unit: r.corpo.unit };
  }
  if (r.status === 401 || r.status === 403) {
    return { ok: false, status: r.status, message: (r.corpo && r.corpo.message) || (r.status === 401 ? "E-mail ou senha incorretos." : "Acesso negado.") };
  }
  return { ok: false, status: 502, message: "Não consegui falar com o sistema da Top English agora. Tente novamente." };
}

// GET {CMS}/admin/auth/me com cache de 60 s por hash do token.
// Devolve { ok:true, me } | { ok:false, status:401 } (sessão inválida) | { ok:false, status:503 } (falha fechada)
const cache = new Map();
export async function validar(token) {
  if (!token) return { ok: false, status: 401 };
  const k = crypto.createHash("sha256").update(token).digest("hex");
  const c = cache.get(k);
  if (c && Date.now() - c.em < TTL_CACHE_MS) return { ok: true, me: c.me };
  let r;
  try { r = await cms("/admin/auth/me", { headers: { Authorization: "Bearer " + token } }); }
  catch { cache.delete(k); return { ok: false, status: 503 }; }
  if (r.status === 200 && r.corpo && r.corpo.user) {
    cache.set(k, { me: r.corpo, em: Date.now() });
    if (cache.size > 5000) for (const [kk, v] of cache) if (Date.now() - v.em > TTL_CACHE_MS) cache.delete(kk);
    return { ok: true, me: r.corpo };
  }
  cache.delete(k);
  if (r.status === 401 || r.status === 403) return { ok: false, status: 401 };
  return { ok: false, status: 503 };
}
export function esquecer(token) {
  if (token) cache.delete(crypto.createHash("sha256").update(token).digest("hex"));
}
