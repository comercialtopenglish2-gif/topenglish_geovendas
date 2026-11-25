// GeoVenda · servidor (gateway). Só entrega public/ a quem tem sessão válida no Top English CMS.
import express from "express";
import compression from "compression";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as auth from "./auth.js";
import * as db from "./db.js";
import * as ai from "./ai.js";
import * as links from "./links.js";
import { identidade, identidadeAdmin, ufDe, MSG_SEM_ACESSO, MSG_PERFIL_BLOQUEADO, franqueadoresFixos } from "./roles.js";
import crypto from "node:crypto";

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
    "X-Frame-Options": "SAMEORIGIN",
    "Content-Security-Policy": "frame-ancestors 'self'",
  });
  if (PROD) res.set("Strict-Transport-Security", "max-age=31536000");
  next();
});

// ---------- rotas públicas ----------
app.get("/healthz", (req, res) => res.json({ status: "ok" }));
app.get("/login", (req, res) => { res.set("Cache-Control", "no-store"); res.sendFile(path.join(LOGIN, "login.html")); });
app.use("/login", express.static(LOGIN, { index: false, dotfiles: "deny", fallthrough: false }));
// Link rastreável (exceção pública aprovada em 25/11/2026): só conta o clique e redireciona; não mostra dados
app.get("/l/:codigo", (req, res) => links.redirecionar(req, res));

function proximoSeguro(n) {
  return typeof n === "string" && /^\/(?!\/)[^\\\s]*$/.test(n) && !n.startsWith("/login") ? n : "/";
}

app.post("/auth/login", express.json({ limit: "10kb" }), async (req, res) => {
  const emailDigitado = String((req.body && req.body.email) || "").trim();
  const email = emailDigitado.toLowerCase();
  const password = String((req.body && req.body.password) || "");
  if (!email || !password) return res.status(400).json({ message: "Informe e-mail e senha." });
  if (auth.bloqueadoPorTentativas(req.ip, email)) return res.status(429).json({ message: "Muitas tentativas. Aguarde 15 minutos e tente de novo." });
  const r = await auth.loginCms(emailDigitado, password);
  if (!r.ok) return res.status(r.status).json({ message: r.message });
  if (auth.MODO() === "admin") {
    const v = await auth.validarToken(r.token); // papel e unidade vêm do /admin/auth/me
    if (!v.ok) { console.warn("Login: o CMS aceitou a senha, mas /admin/auth/me falhou (" + v.status + ")."); return res.status(v.status === 401 ? 401 : 503).json({ message: v.status === 401 ? "O sistema da Top English recusou a sessão." : "Não consegui validar seu acesso agora. Tente novamente." }); }
    const uf = ufDe(v.me.unit && v.me.unit.state);
    try { await db.registrarDoCms(v.me, uf); } catch (e) { console.error("registrarDoCms falhou:", e.message); }
    let dp = null; try { dp = await db.dePara(v.me.user && v.me.user.unit_id); } catch {}
    const ida = identidadeAdmin(v.me, dp);
    if (!ida.ok) { console.info("Login: papel do CMS sem acesso ao GeoVenda (role_id " + (v.me.user && v.me.user.role_id) + ")."); return res.status(403).json({ message: MSG_PERFIL_BLOQUEADO }); }
    try { await auth.criarSessao(res, { pessoaId: ida.pessoaId, email: ida.email, token: r.token, exp: r.exp }); }
    catch (e) { console.error("criarSessao falhou:", e.message); return res.status(503).json({ message: "Banco indisponível. Tente novamente." }); }
    return res.set("Cache-Control", "no-store").json({ ok: true, next: proximoSeguro(req.body && req.body.next) });
  }
  // o token acabou de vir do CMS; confere que ele abre a API (e lê o perfil do CMS, só informativo)
  const v = await auth.validarToken(r.token);
  if (!v.ok) { console.warn("Login: o CMS aceitou a senha, mas a conferência do token falhou (" + v.status + ")."); return res.status(v.status === 401 ? 401 : 503).json({ message: v.status === 401 ? "O sistema da Top English recusou a sessão." : "Não consegui validar seu acesso agora. Tente novamente." }); }
  const pessoaId = r.userId != null ? "cms-" + r.userId : "em-" + crypto.createHash("sha256").update(email).digest("hex").slice(0, 16);
  try { await db.registrarPessoa({ pessoaId, email, nome: r.nome, perfil: v.perfil }); } catch (e) { console.error("registrarPessoa falhou:", e.message); }
  let acesso = null;
  try {
    acesso = await db.acessoDe(email);
    if (!acesso && franqueadoresFixos().includes(email)) { await db.salvarAcesso(email, { papel: "franqueador" }, "railway"); acesso = await db.acessoDe(email); }
  } catch (e) { return res.status(503).json({ message: "Banco indisponível. Tente novamente." }); }
  const id = identidade({ pessoaId, email }, acesso, r.nome);
  if (!id.ok) { console.info("Login: senha correta, mas o e-mail ainda não tem acesso liberado no GeoVenda."); return res.status(403).json({ message: MSG_SEM_ACESSO }); }
  try { await auth.criarSessao(res, { pessoaId, email, token: r.token, exp: r.exp }); }
  catch (e) { console.error("criarSessao falhou:", e.message); return res.status(503).json({ message: "Banco indisponível. Tente novamente." }); }
  res.set("Cache-Control", "no-store").json({ ok: true, next: proximoSeguro(req.body && req.body.next) });
});

app.post("/auth/logout", async (req, res) => {
  try { await auth.encerrarSessao(req); } catch {}
  auth.apagarSessao(res);
  res.set("Cache-Control", "no-store").json({ ok: true });
});

// ---------- portão: tudo daqui para baixo exige sessão ----------
const querHtml = req => req.method === "GET" && !req.path.startsWith("/api/") && (req.accepts(["html", "json"]) === "html");
const semSessao = (req, res) => {
  if (auth.lerCookie(req, auth.COOKIE)) auth.apagarSessao(res);
  if (querHtml(req)) return res.redirect(302, "/login?next=" + encodeURIComponent(proximoSeguro(req.originalUrl)));
  return res.status(401).json({ code: "unauthenticated", message: "Faça login novamente." });
};

app.use(async (req, res, next) => {
  let sessao;
  try { sessao = await auth.lerSessao(req); }
  catch (e) { return res.status(503).json({ code: "unavailable", message: "Banco indisponível." }); }
  if (!sessao) return semSessao(req, res);
  const v = await auth.validarToken(sessao.token);
  if (!v.ok) {
    if (v.status === 401) { try { await auth.encerrarSessao(req); } catch {} return semSessao(req, res); }
    res.set("Retry-After", "30");
    if (querHtml(req)) return res.status(503).type("html").send(paginaAviso("Não consegui validar seu acesso agora. Tente novamente em instantes."));
    return res.status(503).json({ code: "unavailable", message: "Não consegui validar seu acesso agora. Tente novamente." });
  }
  let id;
  if (auth.MODO() === "admin") {
    let dp = null;
    try { dp = await db.dePara(v.me.user && v.me.user.unit_id); } catch (e) { return res.status(503).json({ code: "unavailable", message: "Banco indisponível." }); }
    id = identidadeAdmin(v.me, dp);
    if (id.ok && id.pessoaId !== sessao.pessoaId) id = { ok: false }; // a sessão é de outra pessoa: recusa
  } else {
    let acesso = null, nome = null;
    try { [acesso, nome] = await Promise.all([db.acessoDe(sessao.email), db.nomePessoa(sessao.pessoaId)]); }
    catch (e) { return res.status(503).json({ code: "unavailable", message: "Banco indisponível." }); }
    id = identidade(sessao, acesso, nome);
  }
  if (!id.ok) {
    try { await auth.encerrarSessao(req); } catch {}
    auth.apagarSessao(res);
    const msgBloq = auth.MODO() === "admin" ? MSG_PERFIL_BLOQUEADO : MSG_SEM_ACESSO;
    if (querHtml(req)) return res.status(403).type("html").send(paginaAviso(msgBloq, true));
    return res.status(403).json({ code: "forbidden", message: msgBloq });
  }
  // Campanhas e brindes: master sempre na unidade dele; franqueador escolhe Unidade (a da conta) ou Franqueadora (com código)
  id.campEscopo = !id.master ? (id.unitId != null ? "u" + id.unitId : null)
    : sessao.redeCamp ? "rede" : (sessao.campUnidade && id.unidadePropria ? "u" + id.unidadePropria.id : null);
  id.redeCamp = id.campEscopo === "rede";
  req.gv = id; req.sessao = sessao;
  if (id.pendente && req.path !== "/api/session" && req.path !== "/claude-shim.js") {
    if (querHtml(req)) return res.status(403).type("html").send(paginaAviso(id.motivoPendente, true));
    return res.status(403).json({ code: "pendente", message: id.motivoPendente });
  }
  next();
});

// ---------- API ----------
const json2mb = express.json({ limit: "2mb" });
const sessaoPublica = id => ({
  pessoa: { id: id.pessoaId, nome: id.nome || id.email, email: id.email },
  papel: id.papel, rotulo: id.rotulo, master: id.master, editaBase: id.editaBase,
  unidade: { id: id.unitId, nome: id.unidade, uf: id.uf, cidade: id.cidade },
  espaco: id.espaco, pendente: id.pendente, redeCamp: !!id.redeCamp, campEscopo: id.campEscopo || null,
  unidadePropria: id.master && id.unidadePropria ? { id: id.unidadePropria.id, nome: id.unidadePropria.nome } : null,
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
app.get("/api/links", (req, res) => links.listar(req.gv, req.query.dias).then(r => res.set("Cache-Control", "no-store").json(r)).catch(e => links.trata(res, e)));
app.post("/api/links", express.json({ limit: "20kb" }), (req, res) => links.criar(req.gv, req.body).then(r => res.status(201).json(r)).catch(e => links.trata(res, e)));
app.patch("/api/links/:codigo", express.json({ limit: "20kb" }), (req, res) => links.editar(req.gv, req.params.codigo, req.body).then(r => res.json(r)).catch(e => links.trata(res, e)));
app.delete("/api/links/:codigo", (req, res) => links.apagar(req.gv, req.params.codigo).then(() => res.json({ ok: true })).catch(e => links.trata(res, e)));
app.get("/api/ai/uso", (req, res) => ai.uso(req, res, req.gv).catch(e => trataErro(res, e)));
app.get("/api/ai/diagnostico", (req, res) => { if (!req.gv || !req.gv.master) return res.status(403).json({ code: "forbidden", message: "Só o franqueador pode testar a IA." }); ai.diagnostico(req, res).catch(e => trataErro(res, e)); });
app.post("/api/ai/sample", express.json({ limit: "30mb" }), (req, res) => ai.sample(req, res, req.gv).catch(e => trataErro(res, e)));

// acessos e unidades (a API de produção do CMS não informa papel nem unidade): só franqueador
const soMaster = (req, res, next) => req.gv.master ? next() : res.status(403).json({ code: "forbidden", message: "Somente franqueador." });
app.get("/api/acessos", soMaster, async (req, res) => {
  try {
    if (auth.MODO() === "admin") return res.json({ modo: "admin", ...(await db.painelUnidadesCms()), eu: req.gv.email });
    res.json({ modo: "legado", ...(await db.painelAcessos()), fixos: franqueadoresFixos(), eu: req.gv.email });
  } catch (e) { trataErro(res, e); }
});
app.post("/api/unidades", soMaster, json2mb, async (req, res) => {
  if (auth.MODO() === "admin") return res.status(400).json({ code: "invalid_argument", message: "As unidades vêm do sistema da Top English." }); try { res.json(await db.criarUnidade(req.body || {})); } catch (e) { trataErro(res, e); } });
app.put("/api/unidades/:id", soMaster, json2mb, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ code: "invalid_argument", message: "Unidade inválida." });
  try { await db.salvarUnidade(req.params.id, req.body || {}); res.json({ ok: true }); } catch (e) { trataErro(res, e); }
});
app.put("/api/acessos/:email", soMaster, json2mb, async (req, res) => {
  if (auth.MODO() === "admin") return res.status(400).json({ code: "invalid_argument", message: "Os papéis vêm do sistema da Top English." });
  const email = String(req.params.email || "").toLowerCase();
  if (email === req.gv.email && (req.body || {}).papel !== "franqueador") return res.status(400).json({ code: "invalid_argument", message: "Você não pode tirar o seu próprio acesso de franqueador." });
  try { await db.salvarAcesso(email, req.body || {}, req.gv.email); res.json({ ok: true }); } catch (e) { trataErro(res, e); }
});
app.delete("/api/acessos/:email", soMaster, async (req, res) => {
  const email = String(req.params.email || "").toLowerCase();
  if (email === req.gv.email) return res.status(400).json({ code: "invalid_argument", message: "Você não pode remover o seu próprio acesso." });
  try { await db.removerAcesso(email); res.json({ ok: true }); } catch (e) { trataErro(res, e); }
});
app.get(["/acessos", "/unidades"], (req, res) => {
  if (!req.gv.master) return res.status(403).type("html").send(paginaAviso("Somente o franqueador libera acessos."));
  // aberta direto no navegador (não dentro do GeoVenda): leva para o app, com o menu ao lado
  if (req.get("sec-fetch-dest") === "document") return res.redirect(302, "/?tela=acessos");
  res.set("Cache-Control", "private, no-store").sendFile(path.join(RAIZ, "server", "paginas", "acessos.html"));
});
// Campanhas e brindes: código da franqueadora para ver todas as unidades (valor em CAMP_CODIGO_REDE, no Railway)
const tentativasCodigo = new Map();
app.post("/api/campanhas/rede", json2mb, async (req, res) => {
  if (!req.gv.master) return res.status(403).json({ code: "forbidden", message: "Somente a franqueadora vê todas as unidades." });
  const certo = String(process.env.CAMP_CODIGO_REDE || "");
  if (!certo) return res.status(503).json({ code: "unavailable", message: "O código da franqueadora ainda não foi configurado no servidor." });
  const k = req.sessao.idHash, agora = Date.now();
  const lista = (tentativasCodigo.get(k) || []).filter(t => agora - t < 15 * 60 * 1000);
  if (lista.length >= 5) return res.status(429).json({ code: "rate_limited", message: "Muitas tentativas. Aguarde 15 minutos." });
  const dig = String((req.body || {}).codigo || "").trim();
  const a = crypto.createHash("sha256").update(dig).digest(), b = crypto.createHash("sha256").update(certo).digest();
  if (!crypto.timingSafeEqual(a, b)) { lista.push(agora); tentativasCodigo.set(k, lista); return res.status(403).json({ code: "codigo_errado", message: "Código incorreto." }); }
  tentativasCodigo.delete(k);
  await auth.liberarRedeCamp(k);
  res.json({ ok: true });
});
app.post("/api/campanhas/unidade", async (req, res) => {
  if (!req.gv.master) return res.status(400).json({ code: "invalid_argument", message: "Você já entra como a sua unidade." });
  if (!req.gv.unidadePropria) return res.status(400).json({ code: "invalid_argument", message: "Esta conta não tem unidade no sistema da Top English." });
  await auth.escolherUnidadeCamp(req.sessao.idHash);
  res.json({ ok: true });
});
app.post("/api/campanhas/sair", async (req, res) => {
  if (req.gv.master) await auth.sairVisaoCamp(req.sessao.idHash);
  res.json({ ok: true });
});
app.use("/api", (req, res) => res.status(404).json({ code: "not_found", message: "Rota inexistente." }));

// ---------- app (só public/) ----------
const paginasCache = {};
function paginaComSessao(arquivo, id) {
  if (!paginasCache[arquivo] || !PROD) paginasCache[arquivo] = fs.readFileSync(path.join(PUBLIC, arquivo), "utf8");
  const sess = JSON.stringify(sessaoPublica(id)).replace(/</g, "\\u003c");
  const inj = `<head>\n<script>window.GV_SESSION=${sess};</script>\n<script src="/claude-shim.js"></script>`;
  return paginasCache[arquivo].replace(/<head>/i, inj);
}
const indexComSessao = id => paginaComSessao("index.html", id);
app.get(["/", "/index.html"], (req, res) => {
  res.set({ "Cache-Control": "private, no-store", "Content-Type": "text/html; charset=utf-8" }).send(indexComSessao(req.gv));
});
// Campanhas e brindes (aberta dentro do GeoVenda, em Medir)
app.get(["/campanhas", "/campanhas.html"], async (req, res) => {
  if (req.gv.campEscopo) try { await db.garantirUnidadesCampanha(req.gv); } catch (e) { console.error("garantirUnidadesCampanha falhou:", e.message); }
  res.set({ "Cache-Control": "private, no-store", "Content-Type": "text/html; charset=utf-8" }).send(paginaComSessao("campanhas.html", req.gv));
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
  app.listen(PORT, () => console.log(`GeoVenda no ar na porta ${PORT} (${PROD ? "produção" : "desenvolvimento"}), CMS: ${process.env.CMS_BASE_URL || "https://cms.topenglish.com.br"}, API do CMS: ${auth.MODO()}`));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) iniciar();
export { app, iniciar };
