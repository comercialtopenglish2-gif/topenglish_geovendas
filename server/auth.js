// Login e sessão no Top English CMS. Dois modos, escolhidos por CMS_API:
//  - "admin" (padrão): API /admin do CMS (docs/INTEGRACAO_API_FRONT.md). POST /admin/auth/login e GET /admin/auth/me,
//    que devolvem papel (role_id) e unidade. Disponível em cmsdev.topenglish.com.br; será publicada em cms.topenglish.com.br.
//  - "legado": API que está hoje em cms.topenglish.com.br (docs/GUIA_INTEGRACAO_FRONT_API.md). Login v2 assinado no servidor
//    (CMS_PASSWORD_SECRET) ou v1 servidor-a-servidor; validação por /webbook/teacher/dashboard; papel pela tabela acessos.
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
export const MODO = () => String(process.env.CMS_API || "admin").trim().toLowerCase() === "legado" ? "legado" : "admin";

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
  if (/not found|não encontrad/i.test(t)) return "E-mail não encontrado no sistema da Top English. Confira se é o mesmo e-mail do CMS.";
  if (/incorrect|incorret|senha|password/i.test(t)) return "Senha incorreta para este e-mail no sistema da Top English.";
  return "O sistema da Top English não aceitou o login" + (t ? " (" + t.slice(0, 80) + ")" : "") + ".";
}
// resumo seguro de uma resposta do CMS para o log: status, campos e a mensagem do CMS (nunca valores de token)
function resumo(r) {
  const c = (r && r.corpo) || {};
  const campos = c && typeof c === "object" ? Object.keys(c).concat(c.content && typeof c.content === "object" ? Object.keys(c.content).map(k => "content." + k) : []) : [];
  return `HTTP ${r && r.status}, campos [${campos.join(", ")}]${c.message ? ", mensagem do CMS: " + String(c.message).slice(0, 80) : ""}`;
}

// payload do JWT de sessão do CMS (só para ler user_id e exp de um token que ACABOU de vir do CMS, servidor-a-servidor)
function lerPayload(token) {
  try { return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8")); } catch { return {}; }
}

// ---------- modo "admin": POST /admin/auth/login e GET /admin/auth/me ----------
async function loginAdmin(email, password) {
  let r;
  try { r = await cms("/admin/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) }); }
  catch { return { ok: false, status: 502, message: "Não consegui falar com o sistema da Top English agora. Tente novamente." }; }
  const c = r.corpo || {};
  if (r.status >= 200 && r.status < 300 && c.token) {
    const u = c.user || {};
    return { ok: true, token: c.token, nome: u.name || u.nickname || null, userId: u.id ?? null, exp: Date.now() + (Number(c.expires_in_hours) || 24) * 3600 * 1000, user: u, unit: c.unit || null };
  }
  console.warn("Login no CMS (admin) não aceito: " + resumo(r));
  if (r.status === 401) return { ok: false, status: 401, message: "E-mail ou senha incorretos." };
  if (r.status === 403) return { ok: false, status: 403, message: c.message || "Acesso negado pelo sistema da Top English." };
  return { ok: false, status: 502, message: "O sistema da Top English não respondeu. Tente novamente." };
}
const cacheMe = new Map();
async function validarAdmin(token) {
  const k = sha(token), c = cacheMe.get(k);
  if (c && Date.now() - c.em < TTL_CACHE_MS) return { ok: true, me: c.me };
  let r;
  try { r = await cms("/admin/auth/me", { headers: { Authorization: "Bearer " + token } }); }
  catch { cacheMe.delete(k); console.warn("Validação: /admin/auth/me sem resposta."); return { ok: false, status: 503 }; }
  if (r.status === 200 && r.corpo && r.corpo.user) {
    cacheMe.set(k, { me: r.corpo, em: Date.now() });
    if (cacheMe.size > 5000) for (const [kk, v] of cacheMe) if (Date.now() - v.em > TTL_CACHE_MS) cacheMe.delete(kk);
    return { ok: true, me: r.corpo };
  }
  cacheMe.delete(k);
  if (r.status === 401 || r.status === 403) return { ok: false, status: 401 };
  console.warn("Validação: /admin/auth/me respondeu " + r.status + ".");
  return { ok: false, status: 503 };
}

// Login no CMS. Devolve { ok, token, nome, userId, exp } ou { ok:false, status, message }
export async function loginCms(email, password) {
  if (MODO() === "admin") return loginAdmin(email, password);
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
      const c = (r.corpo && r.corpo.content) || {};
      const token = r.corpo && (r.corpo.token || r.corpo.token_auth || c.token || c.token_auth);
      if (r.status < 300 && token && r.corpo.status !== "ERROR") {
        const p = lerPayload(token);
        return { ok: true, token, nome: c.name || r.corpo.name || null, userId: p.user_id ?? null, exp: p.exp ? p.exp * 1000 : null };
      }
    }
  } catch {
    return { ok: false, status: 502, message: "Não consegui falar com o sistema da Top English agora. Tente novamente." };
  }
  console.warn("Login no CMS (" + (process.env.CMS_PASSWORD_SECRET ? "v2" : "v1") + ") não aceito: " + resumo(r));
  if (r && r.status >= 500) return { ok: false, status: 502, message: "O sistema da Top English não respondeu. Tente novamente." };
  const m = String((r && r.corpo && r.corpo.message) || "");
  if (process.env.CMS_PASSWORD_SECRET && /payload|signature|assinatura|decode/i.test(m) && !/password|not found|desactivat/i.test(m)) {
    console.error("Login v2: o CMS recusou o payload assinado. Confira a variável CMS_PASSWORD_SECRET.");
    return { ok: false, status: 502, message: "O login está mal configurado no servidor. Avise o suporte do GeoVenda." };
  }
  return { ok: false, status: 401, message: mensagemErro(r && r.corpo && r.corpo.message) };
}

// Confere o token no CMS. Devolve { ok:true, perfil } | { ok:false, status:401 } | { ok:false, status:503 }
// 1º: GET /webbook/teacher/dashboard (traz o perfil). Se o dashboard falhar por outro motivo que não seja token
// inválido (ex.: franqueador sem turmas), confere em GET /v1/enrollment.json, que vale para qualquer User.
const cache = new Map();
const tokenRecusado = (st, b) => st === 401 || st === 403 || (b && b.status === "ERROR" && (b.code === 101 || /token|expir|auth|inválid|invalid|unauthori|payload|login/i.test(String(b.message || ""))));
export async function validarToken(token) {
  if (!token) return { ok: false, status: 401 };
  if (MODO() === "admin") return validarAdmin(token);
  const k = sha(token);
  const c = cache.get(k);
  if (c && Date.now() - c.em < TTL_CACHE_MS) return { ok: true, perfil: c.perfil };
  const guardar = perfil => { cache.set(k, { perfil, em: Date.now() }); if (cache.size > 5000) for (const [kk, v] of cache) if (Date.now() - v.em > TTL_CACHE_MS) cache.delete(kk); return { ok: true, perfil }; };
  const auth = { Authorization: "Bearer " + token };
  let r;
  try { r = await cms("/webbook/teacher/dashboard", { headers: auth }); }
  catch { cache.delete(k); console.warn("Validação: dashboard do CMS sem resposta."); return { ok: false, status: 503 }; }
  const b = r.corpo || {};
  if (r.status === 200 && b.status !== "ERROR") return guardar((b.content && (b.content.role || b.content.my_profile_name)) || null);
  if (tokenRecusado(r.status, b)) { cache.delete(k); return { ok: false, status: 401 }; }
  console.warn(`Validação: dashboard do CMS respondeu ${r.status}${b.code ? " código " + b.code : ""}; conferindo por /v1/enrollment.`);
  let r2;
  try { r2 = await cms("/v1/enrollment.json", { headers: auth }); }
  catch { cache.delete(k); return { ok: false, status: 503 }; }
  const b2 = r2.corpo;
  if (r2.status === 200 && !(b2 && !Array.isArray(b2) && b2.status === "ERROR")) return guardar(null);
  cache.delete(k);
  if (tokenRecusado(r2.status, b2 && !Array.isArray(b2) ? b2 : null)) return { ok: false, status: 401 };
  console.warn(`Validação: /v1/enrollment respondeu ${r2.status}.`);
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
  const r = await getPool().query("SELECT pessoa_id, email, token, rede_camp FROM sessoes WHERE id_hash=$1 AND expira_em > now()", [sha(id)]);
  return r.rows[0] ? { pessoaId: r.rows[0].pessoa_id, email: r.rows[0].email, token: r.rows[0].token, redeCamp: !!r.rows[0].rede_camp, idHash: sha(id) } : null;
}
// Campanhas e brindes: libera a visão da rede toda nesta sessão (só para quem digitou o código certo)
export async function liberarRedeCamp(idHash) {
  await getPool().query("UPDATE sessoes SET rede_camp=true WHERE id_hash=$1", [idHash]);
}
export async function encerrarSessao(req) {
  const id = lerCookie(req, COOKIE);
  if (!id || !/^[a-f0-9]{64}$/.test(id)) return;
  const r = await getPool().query("DELETE FROM sessoes WHERE id_hash=$1 RETURNING token", [sha(id)]);
  if (r.rows[0]) { cache.delete(sha(r.rows[0].token)); cacheMe.delete(sha(r.rows[0].token)); }
}
