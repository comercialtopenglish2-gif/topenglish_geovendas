// GeoVenda · servidor (gateway). Só entrega public/ a quem tem sessão válida no Top English CMS.
import express from "express";
import compression from "compression";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as auth from "./auth.js";
import * as db from "./db.js";
import * as ai from "./ai.js";
import { identidade, MSG_SEM_ACESSO } from "./roles.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, "..");
const PUBLIC = path.join(RAIZ, "public");
const LOGIN = path.join(RAIZ, "login");
const PROD = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT || 8080);

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // Railway fica na frente
app.use(compression());
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
  });
  if (PROD) res.set("Strict-Transport-Security", "max-age=31536000");
  next();
});

// ---------- rotas públicas ----------
app.get("/healthz", (req, res) => res.json({ status: "ok" }));
app.get("/login", (req, res) => { res.set("Cache-Control", "no-store"); res.sendFile(path.join(LOGIN, "login.html")); });
app.use("/login", express.static(LOGIN, { index: false, dotfiles: "deny", fallthrough: false }));

function proximoSeguro(n) {
  return typeof n === "string" && /^\/(?!\/)[^\\\s]*$/.test(n) && !n.startsWith("/login") ? n : "/";
}

app.post("/auth/login", express.json({ limit: "10kb" }), async (req, res) => {
  const email = String((req.body && req.body.email) || "").trim();
  const password = String((req.body && req.body.password) || "");
  if (!email || !password) return res.status(400).json({ message: "Informe e-mail e senha." });
  if (auth.bloqueadoPorTentativas(req.ip, email)) return res.status(429).json({ message: "Muitas tentativas. Aguarde 15 minutos e tente de novo." });
  const r = await auth.loginCms(email, password);
  if (!r.ok) return res.status(r.status).json({ message: r.message });
  const v = await auth.validar(r.token); // confere o papel real pelo /me
  if (!v.ok) return res.status(v.status === 401 ? 401 : 503).json({ message: v.status === 401 ? "Sessão recusada pelo CMS." : "Não consegui validar seu acesso agora. Tente novamente." });
  const me = { ...v.me, user: { ...(r.user || {}), ...(v.me.user || {}) }, unit: (v.me.unit || r.unit) ? { ...(r.unit || {}), ...(v.me.unit || {}) } : null };
  const id = identidade(me, null);
  if (!id.ok) { auth.esquecer(r.token); return res.status(403).json({ message: MSG_SEM_ACESSO }); }
  try { await db.registrarPessoa(me); } catch (e) { console.error("registrarPessoa falhou:", e.message); }
  auth.gravarSessao(res, r.token, r.horas);
  res.set("Cache-Control", "no-store").json({ ok: true, next: proximoSeguro(req.body && req.body.next) });
});

app.post("/auth/logout", (req, res) => {
  auth.esquecer(auth.lerCookie(req, auth.COOKIE));
  auth.apagarSessao(res);
  res.set("Cache-Control", "no-store").json({ ok: true });
});

// ---------- portão: tudo daqui para baixo exige sessão ----------
const querHtml = req => req.method === "GET" && !req.path.startsWith("/api/") && (req.accepts(["html", "json"]) === "html");
const pessoasNome = new Map();

app.use(async (req, res, next) => {
  const token = auth.lerCookie(req, auth.COOKIE);
  const v = await auth.validar(token);
  if (!v.ok) {
    if (v.status === 401) {
      if (token) auth.apagarSessao(res);
      if (querHtml(req)) return res.redirect(302, "/login?next=" + encodeURIComponent(proximoSeguro(req.originalUrl)));
      return res.status(401).json({ code: "unauthenticated", message: "Faça login novamente." });
    }
    res.set("Retry-After", "30");
    if (querHtml(req)) return res.status(503).type("html").send(paginaAviso("Não consegui validar seu acesso agora. Tente novamente em instantes."));
    return res.status(503).json({ code: "unavailable", message: "Não consegui validar seu acesso agora. Tente novamente." });
  }
  let dp = null;
  try { dp = await db.dePara(v.me.user && v.me.user.unit_id); } catch (e) { return res.status(503).json({ code: "unavailable", message: "Banco indisponível." }); }
  const id = identidade(v.me, dp);
  if (!id.ok) {
    auth.apagarSessao(res);
    if (querHtml(req)) return res.status(403).type("html").send(paginaAviso(MSG_SEM_ACESSO, true));
    return res.status(403).json({ code: "forbidden", message: MSG_SEM_ACESSO });
  }
  if (!pessoasNome.has(id.pessoaId)) {
    try { const p = await db.perfis([id.pessoaId]); pessoasNome.set(id.pessoaId, (p[id.pessoaId] || {}).name || null); } catch {}
  }
  id.nome = pessoasNome.get(id.pessoaId) || null;
  req.gv = id;
  if (id.pendente && req.path !== "/api/session" && req.path !== "/claude-shim.js") {
    if (querHtml(req)) return res.status(403).type("html").send(paginaAviso(id.motivoPendente, true));
    return res.status(403).json({ code: "pendente", message: id.motivoPendente });
  }
  next();
});

// ---------- API ----------
const json2mb = express.json({ limit: "2mb" });
const sessaoPublica = id => ({
  pessoa: { id: id.pessoaId, nome: id.nome },
  papel: id.papel, rotulo: id.rotulo, master: id.master, editaBase: id.editaBase,
  unidade: { id: id.unitId, nome: id.unidade, uf: id.uf, cidade: id.cidade },
  espaco: id.espaco, pendente: id.pendente,
  ia: ai.iaLigada(),
});
app.get("/api/session", (req, res) => res.set("Cache-Control", "no-store").json(sessaoPublica(req.gv)));

function trataErro(res, e) {
  if (e instanceof db.ErroDb) return res.status(e.status).json({ code: e.code, message: e.message });
  console.error("Erro interno:", e && e.message);
  res.status(500).json({ code: "unavailable", message: "Erro interno." });
}
app.post("/api/db/:op", json2mb, async (req, res) => {
  const b = req.body || {};
  try {
    switch (req.params.op) {
      case "get": return res.json(await db.getDoc(req.gv, b.path));
      case "list": return res.json(await db.listar(req.gv, b.path, b.where || null, b.since || null));
      case "set": return res.json(await db.setDoc(req.gv, b.path, b.data));
      case "update": return res.json(await db.updateDoc(req.gv, b.path, b.data));
      case "delete": return res.json(await db.delDoc(req.gv, b.path));
      default: return res.status(404).json({ code: "not_found", message: "Operação desconhecida." });
    }
  } catch (e) { trataErro(res, e); }
});
app.post("/api/pessoas", json2mb, async (req, res) => {
  try { res.json(await db.perfis((req.body || {}).ids)); } catch (e) { trataErro(res, e); }
});
app.get("/api/ai/limits", (req, res) => res.json(ai.limites()));
app.post("/api/ai/sample", express.json({ limit: "30mb" }), (req, res) => ai.sample(req, res, req.gv).catch(e => trataErro(res, e)));

// de-para de unidades (D3b), só franqueador
const soMaster = (req, res, next) => req.gv.master ? next() : res.status(403).json({ code: "forbidden", message: "Somente franqueador." });
app.get("/api/unidades", soMaster, async (req, res) => { try { res.json(await db.listarUnidades()); } catch (e) { trataErro(res, e); } });
app.put("/api/unidades/:id", soMaster, json2mb, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ code: "invalid_argument", message: "Unidade inválida." });
  try { await db.salvarUnidade(req.params.id, req.body || {}); res.json({ ok: true }); } catch (e) { trataErro(res, e); }
});
app.get("/unidades", (req, res) => {
  if (!req.gv.master) return res.status(403).type("html").send(paginaAviso("Somente o franqueador configura as unidades."));
  res.set("Cache-Control", "private, no-store").sendFile(path.join(RAIZ, "server", "paginas", "unidades.html"));
});
app.use("/api", (req, res) => res.status(404).json({ code: "not_found", message: "Rota inexistente." }));

// ---------- app (só public/) ----------
let indexCache = null;
function indexComSessao(id) {
  if (!indexCache || !PROD) indexCache = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  const sess = JSON.stringify(sessaoPublica(id)).replace(/</g, "\\u003c");
  const inj = `<head>\n<script>window.GV_SESSION=${sess};</script>\n<script src="claude-shim.js"></script>`;
  return indexCache.replace(/<head>/i, inj);
}
app.get(["/", "/index.html"], (req, res) => {
  res.set({ "Cache-Control": "private, no-store", "Content-Type": "text/html; charset=utf-8" }).send(indexComSessao(req.gv));
});
// D2: master (role 2) só recebe os dados da UF da unidade dele; franqueador recebe todas
app.get(/^\/(data|bairros)\/([A-Z]{2})\.json$/, (req, res, next) => {
  const uf = req.params[1];
  if (req.gv.master || uf === req.gv.uf) return next();
  res.status(403).json({ code: "forbidden", message: "Estado fora da sua unidade." });
});
app.use(express.static(PUBLIC, {
  index: false, dotfiles: "deny", redirect: false,
  setHeaders: (res, p) => res.set("Cache-Control", p.endsWith(".html") ? "private, no-store" : "private, max-age=3600"),
}));
app.use((req, res) => res.status(404).type("text/plain").send("Não encontrado."));

function paginaAviso(msg, sair) {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GeoVenda</title><link rel="stylesheet" href="/login/login.css"></head><body><main class="card"><h1>GeoVenda</h1><p>${esc(msg)}</p>${sair ? '<button id="sair" class="btn">Sair</button><script>document.getElementById("sair").onclick=()=>fetch("/auth/logout",{method:"POST"}).then(()=>location.href="/login")</script>' : '<a class="btn" href="/">Tentar de novo</a>'}</main></body></html>`;
}

// ---------- início ----------
async function iniciar() {
  try { await db.migrar(); }
  catch (e) { console.error("Falha ao preparar o banco:", e.message); process.exit(1); }
  if (!ai.iaLigada()) console.warn("ANTHROPIC_API_KEY ausente: recursos de IA ficam desligados.");
  app.listen(PORT, () => console.log(`GeoVenda no ar na porta ${PORT} (${PROD ? "produção" : "desenvolvimento"}), CMS: ${process.env.CMS_BASE_URL || "https://cms.topenglish.com.br"}`));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) iniciar();
export { app, iniciar };
