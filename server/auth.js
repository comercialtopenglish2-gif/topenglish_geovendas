// Login e sessão pela API que está em produção no Top English CMS (docs/GUIA_INTEGRACAO_FRONT_API.md).
//  - Login v2 (preferido): POST /v2/webbook/login com payload JWT HS256 assinado no SERVIDOR com CMS_PASSWORD_SECRET.
//  - Login v1 (quando não há CMS_PASSWORD_SECRET): GET /v1/authentication.json, chamado só servidor-a-servidor, em HTTPS.
//  - Validação contínua: GET /webbook/teacher/dashboard com Authorization: Bearer (cache de 60 s).
// O token do CMS fica no banco (tabela sessoes). O navegador recebe só um id aleatório em cookie HttpOnly.
// Nada aqui registra em log senha, token, cookie ou a URL do login v1.
import crypto from "node:crypto";
import { getPool } from "./db.js";

const CMS = () => (process.env.CMS_BASE_URL || "https://cms.topenglish.com.br").replace(/\/+$/, "");
const PROD = () => process.env.NODE_ENV === "production";
export const COOKIE = "gv_session";
const TTL_CACHE_MS = Number(process.env.AUTH_CACHE_MS || 60 * 1000);
const TIMEOUT_MS = 10000;
const HORAS_SESSAO = 24;

const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const b64url = b => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

// ---------- cookies ----------
export function lerCookie(req, nome) {
  const h = req.headers.cookie || "";
  for (const parte of h.split(";")) {
    const i = parte.indexOf("=");
    if (i > 0 && parte.slice(0, i).trim() === nome) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return null;
}
function gravarCookie(res, valor, maxAge) {
  res.append("Set-Cookie", `${COOKIE}=${encodeURIComponent(valor)}; HttpOnly; ${PROD() ? "Secure; " : ""}SameSite=Lax; Path=/; Max-Age=${maxAge}`);
}
export function apagarSessao(res) { gravarCookie(res, "", 0); }

// ---------- chamada ao CMS ----------
async function cms(caminho, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(CMS() + caminho, { ...opts, signal: ctl.signal, headers: { Accept: "application/json", ...(opts.headers || {}) } });
    let corpo = null; try { corpo = await r.json(); } catch {}
    return { status: r.status, corpo };
  } finally { clearTimeout(t); }
}

// ---------- limite de tentativas (memória) ----------
const tentativas = new Map();
const JANELA = 15 * 60 * 1000, MAX_TENT = 10;
export function bloqueadoPorTentativas(ip, email) {
  const k = ip + "|" + String(email || "").trim().toLowerCase();
  const agora = Date.now();
  const lista = (tentativas.get(k) || []).filter(t => agora - t < JANELA);
  lista.push(agora); tentativas.set(k, lista);
  if (tentativas.size > 5000) for (const [kk, v] of tentativas) if (!v.some(t => agora - t < JANELA)) tentativas.delete(kk);
  return lista.length > MAX_TENT;
}

// ---------- tradução das mensagens do CMS ----------
function mensagemErro(m) {
  const t = String(m || "");
  if (/desactivat|desativad/i.test(t)) return "Usuário desativado no sistema da Top English.";
  if (/not found|incorrect|inválid|invalid|senha|password/i.test(t)) return "E-mail ou senha incorretos.";
  return "Não foi possível entrar com esses dados.";
}

// payload do JWT de sessão do CMS (só para ler user_id e exp de um token que ACABOU de vir do CMS, servidor-a-servidor)
function lerPayload(token) {
  try { return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8")); } catch { return {}; }
}

// Login no CMS. Devolve { ok, token, nome, userId, exp } ou { ok:false, status, message }
export async function loginCms(email, password) {
  let r;
  try {
    const segredo = process.env.CMS_PASSWORD_SECRET;
    if (segredo) {
      const cab = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
      const corpo = b64url(JSON.stringify({ email, password, type: "teacher" }));
      const assinatura = b64url(crypto.createHmac("sha256", segredo).update(cab + "." + corpo).digest());
      r = await cms("/v2/webbook/login.json", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payload: `${cab}.${corpo}.${assinatura}` }) });
      const c = (r.corpo && r.corpo.content) || {};
      if (r.status < 300 && r.corpo && r.corpo.status === "SUCCESS" && (c.token || c.token_auth)) {
        const token = c.token || c.token_auth, p = lerPayload(token);
        return { ok: true, token, nome: c.name || null, userId: p.user_id ?? null, exp: p.exp ? p.exp * 1000 : null };
      }
    } else {
      const qs = new URLSearchParams({ email, pass: password }).toString();
      r = await cms("/v1/authentication.json?" + qs, { method: "GET" });
      const token = r.corpo && (r.corpo.token || r.corpo.token_auth);
      if (r.status < 300 && token && (!r.corpo.status || r.corpo.status !== "ERROR")) {
        const p = lerPayload(token);
        return { ok: true, token, nome: null, userId: p.user_id ?? null, exp: p.exp ? p.exp * 1000 : null };
      }
    }
  } catch {
    return { ok: false, status: 502, message: "Não consegui falar com o sistema da Top English agora. Tente novamente." };
  }
  if (r && r.status >= 500) return { ok: false, status: 502, message: "O sistema da Top English não respondeu. Tente novamente." };
  const m = String((r && r.corpo && r.corpo.message) || "");
  if (process.env.CMS_PASSWORD_SECRET && /payload|signature|assinatura|decode/i.test(m) && !/password|not found|desactivat/i.test(m)) {
    console.error("Login v2: o CMS recusou o payload assinado. Confira a variável CMS_PASSWORD_SECRET.");
    return { ok: false, status: 502, message: "O login está mal configurado no servidor. Avise o suporte do GeoVenda." };
  }
  return { ok: false, status: 401, message: mensagemErro(r && r.corpo && r.corpo.message) };
}

// Confere o token no CMS (dashboard do webbook). Devolve { ok:true, perfil } | { ok:false, status:401 } | { ok:false, status:503 }
const cache = new Map();
export async function validarToken(token) {
  if (!token) return { ok: false, status: 401 };
  const k = sha(token);
  const c = cache.get(k);
  if (c && Date.now() - c.em < TTL_CACHE_MS) return { ok: true, perfil: c.perfil };
  let r;
  try { r = await cms("/webbook/teacher/dashboard", { headers: { Authorization: "Bearer " + token } }); }
  catch { cache.delete(k); return { ok: false, status: 503 }; }
  const b = r.corpo || {};
  if (r.status === 200 && b.status !== "ERROR") {
    const perfil = (b.content && (b.content.role || b.content.my_profile_name)) || null;
    cache.set(k, { perfil, em: Date.now() });
    if (cache.size > 5000) for (const [kk, v] of cache) if (Date.now() - v.em > TTL_CACHE_MS) cache.delete(kk);
    return { ok: true, perfil };
  }
  cache.delete(k);
  if (r.status === 401 || r.status === 403 || (b.status === "ERROR" && /token|expir|auth|inválid|invalid|unauthori|login/i.test(String(b.message || b.type || "")))) return { ok: false, status: 401 };
  return { ok: false, status: 503 };
}

// ---------- sessões do GeoVenda ----------
export async function criarSessao(res, { pessoaId, email, token, exp }) {
  const id = crypto.randomBytes(32).toString("hex");
  const limite = Date.now() + HORAS_SESSAO * 3600 * 1000;
  const expira = Math.min(limite, exp && exp > Date.now() ? exp : limite);
  await getPool().query("DELETE FROM sessoes WHERE expira_em < now()");
  await getPool().query("INSERT INTO sessoes(id_hash,pessoa_id,email,token,expira_em) VALUES ($1,$2,$3,$4,to_timestamp($5/1000.0))",
    [sha(id), pessoaId, email, token, expira]);
  gravarCookie(res, id, Math.max(60, Math.floor((expira - Date.now()) / 1000)));
}
export async function lerSessao(req) {
  const id = lerCookie(req, COOKIE);
  if (!id || !/^[a-f0-9]{64}$/.test(id)) return null;
  const r = await getPool().query("SELECT pessoa_id, email, token FROM sessoes WHERE id_hash=$1 AND expira_em > now()", [sha(id)]);
  return r.rows[0] ? { pessoaId: r.rows[0].pessoa_id, email: r.rows[0].email, token: r.rows[0].token, idHash: sha(id) } : null;
}
export async function encerrarSessao(req) {
  const id = lerCookie(req, COOKIE);
  if (!id || !/^[a-f0-9]{64}$/.test(id)) return;
  const r = await getPool().query("DELETE FROM sessoes WHERE id_hash=$1 RETURNING token", [sha(id)]);
  if (r.rows[0]) cache.delete(sha(r.rows[0].token));
}
