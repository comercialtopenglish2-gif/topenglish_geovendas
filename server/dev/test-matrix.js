// Matriz de testes da seção 2.7 do guia. Rode com o servidor e o CMS falso no ar:
//   BASE=http://localhost:8080 node server/dev/test-matrix.js
// Para o teste "CMS desligado", rode o servidor com AUTH_CACHE_MS=1500 e passe MOCK_PID=<pid do CMS falso>.
const BASE = process.env.BASE || "http://localhost:8080";
const SENHA = "teste123";
let falhas = 0;
const ok = (nome, cond, extra) => { console.log((cond ? "PASSOU " : "FALHOU ") + nome + (extra ? "  · " + extra : "")); if (!cond) falhas++; };

async function req(caminho, { cookie, method = "GET", body, accept = "text/html" } = {}) {
  const r = await fetch(BASE + caminho, { method, redirect: "manual", headers: { Accept: accept, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  return { status: r.status, loc: r.headers.get("location"), setCookie: r.headers.get("set-cookie"), txt, json: (() => { try { return JSON.parse(txt); } catch { return null; } })() };
}
async function login(email) {
  const r = await req("/auth/login", { method: "POST", body: { email, password: SENHA } });
  const c = r.setCookie && r.setCookie.match(/gv_session=([^;]*)/);
  return { r, cookie: c && c[1] ? "gv_session=" + c[1] : null };
}
const db = (cookie, op, body) => req("/api/db/" + op, { cookie, method: "POST", body, accept: "application/json" });

(async () => {
  // 1. sem login nada abre
  for (const p of ["/", "/index.html", "/templates.js", "/data/AL.json", "/bairros/AL.json", "/claude-shim.js"]) {
    const h = await req(p); const j = await req(p, { accept: "application/json" });
    ok("sem login " + p, (h.status === 302 && /^\/login/.test(new URL(h.loc, BASE).pathname)) && j.status === 401 && !/GF_TPL|"vb"|<html/i.test(h.txt + j.txt), `html ${h.status}, json ${j.status}`);
  }
  for (const p of ["/api/session", "/api/db/get"]) { const r = await req(p, { accept: "application/json", method: p.endsWith("get") ? "POST" : "GET", body: p.endsWith("get") ? { path: "config/x" } : undefined }); ok("sem login " + p, r.status === 401, String(r.status)); }
  ok("healthz público", (await req("/healthz", { accept: "application/json" })).status === 200);
  ok("tela de login pública", (await req("/login")).status === 200);
  const nx = await req("/auth/login", { method: "POST", body: { email: "master.rj@teste.com", password: SENHA, next: "//mal.com" } });
  ok("next externo recusado", nx.json && nx.json.next === "/", nx.json && nx.json.next);

  // 2. senha errada
  const errada = await req("/auth/login", { method: "POST", body: { email: "master@teste.com", password: "x" } });
  ok("senha errada: mensagem do CMS, sem cookie", errada.status === 401 && !errada.setCookie && /inválid/i.test(errada.json.message), errada.json && errada.json.message);

  // 3. papéis
  const f = await login("franqueador@teste.com");
  const sf = await req("/api/session", { cookie: f.cookie, accept: "application/json" });
  ok("role 1 entra como franqueador", f.cookie && sf.json && sf.json.master === true && sf.json.pendente === false, JSON.stringify(sf.json && { papel: sf.json.papel, uf: sf.json.unidade.uf }));
  ok("cookie HttpOnly, SameSite=Lax", /HttpOnly/.test(f.r.setCookie) && /SameSite=Lax/.test(f.r.setCookie));
  const app = await req("/", { cookie: f.cookie });
  ok("role 1 recebe o app com sessão e shim", app.status === 200 && app.txt.includes("window.GV_SESSION=") && app.txt.indexOf("claude-shim.js") < app.txt.indexOf("/* PDFs do GeoVenda"), String(app.status));
  ok("role 1 lê templates.js e dados", (await req("/templates.js", { cookie: f.cookie, accept: "*/*" })).status === 200 && (await req("/data/AL.json", { cookie: f.cookie, accept: "*/*" })).status === 200);

  const rj = await login("master.rj@teste.com");
  const srj = await req("/api/session", { cookie: rj.cookie, accept: "application/json" });
  ok("role 2 travado na unidade e UF", srj.json && srj.json.master === false && srj.json.unidade.uf === "RJ" && srj.json.espaco === "unit-7", JSON.stringify(srj.json && srj.json.unidade));

  ok("role 2 recebe dados da UF dele", (await req("/data/RJ.json", { cookie: rj.cookie, accept: "*/*" })).status === 200 && (await req("/bairros/RJ.json", { cookie: rj.cookie, accept: "*/*" })).status === 200);
  ok("role 2 não recebe dados de outra UF", (await req("/data/AL.json", { cookie: rj.cookie, accept: "*/*" })).status === 403 && (await req("/bairros/SP.json", { cookie: rj.cookie, accept: "*/*" })).status === 403);
  ok("role 2 recebe estados.json (comparativo)", (await req("/data/estados.json", { cookie: rj.cookie, accept: "*/*" })).status === 200);
  const prof = await login("professor@teste.com");
  ok("role 3 bloqueado: 403 sem cookie", prof.r.status === 403 && !prof.cookie && /sem acesso ao GeoVenda/i.test(prof.r.json.message), prof.r.json && prof.r.json.message);
  const des = await login("desativado@teste.com");
  ok("desativado recusado pelo CMS", des.r.status === 403 && !des.cookie, des.r.json && des.r.json.message);

  const semUf = await login("master@teste.com");
  const ssu = await req("/api/session", { cookie: semUf.cookie, accept: "application/json" });
  const appSemUf = await req("/", { cookie: semUf.cookie });
  const dbSemUf = await db(semUf.cookie, "get", { path: "vendedor/metodo" });
  ok("role 2 sem UF: configuração pendente, sem dados", ssu.json && ssu.json.pendente === true && appSemUf.status === 403 && /estado configurado/.test(appSemUf.txt) && dbSemUf.status === 403, `app ${appSemUf.status}, db ${dbSemUf.status}`);

  // 4. arquivos fora de public/
  for (const p of ["/server/server.js", "/.env", "/STACK.md", "/docs/INTEGRACAO_API_FRONT.md", "/../package.json", "/%2e%2e/package.json", "/package.json", "/server/dev/mock-cms.js"]) {
    const r = await req(p, { cookie: f.cookie, accept: "*/*" });
    ok("logado não acessa " + p, (r.status === 404 || r.status === 403 || r.status === 400) && !/import |CMS_BASE_URL|"dependencies"/.test(r.txt), String(r.status));
  }

  // 5. regras de dados
  await db(f.cookie, "set", { path: "data/users/cms-1/fu-teste", data: { nome: "lead do franqueador" } });
  const alheio = await db(rj.cookie, "get", { path: "data/users/cms-1/fu-teste" });
  ok("usuário A não lê privado de B", alheio.status === 403, String(alheio.status));
  const proprio = await db(rj.cookie, "set", { path: "data/users/cms-11/fu-1", data: { nome: "Lead RJ", status: "andamento" } });
  const lido = await db(rj.cookie, "get", { path: "data/users/cms-11/fu-1" });
  ok("usuário grava e lê o próprio", proprio.status === 200 && lido.json && lido.json.data.nome === "Lead RJ");
  const cfg = await db(rj.cookie, "set", { path: "config/calibracao", data: { x: 1 } });
  ok("role 2 não escreve em config/*", cfg.status === 403, String(cfg.status));
  ok("role 2 não escreve vendedor/metodo", (await db(rj.cookie, "set", { path: "vendedor/metodo", data: { texto: "x" } })).status === 403);
  ok("role 1 escreve vendedor/metodo", (await db(f.cookie, "set", { path: "vendedor/metodo", data: { texto: "Método PROBAC" } })).status === 200);
  ok("role 2 lê vendedor/metodo", ((await db(rj.cookie, "get", { path: "vendedor/metodo" })).json || {}).data?.texto === "Método PROBAC");
  ok("role 2 grava no espaço da unidade dele", (await db(rj.cookie, "set", { path: "escolas/unit-7/acoes/a1", data: { unidade: "u1", titulo: "Aula aberta" } })).status === 200);
  ok("role 2 não lê espaço de outra unidade", (await db(rj.cookie, "list", { path: "escolas/unit-4/acoes" })).status === 403);
  ok("role 2 não lista todas as escolas", (await db(rj.cookie, "list", { path: "escolas" })).status === 403);
  ok("role 1 lê espaço de qualquer unidade", ((await db(f.cookie, "list", { path: "escolas/unit-7/acoes" })).json || {}).docs?.length === 1);
  ok("role 2 não lista a equipe", (await db(rj.cookie, "list", { path: "equipe" })).status === 403);
  const w = await db(rj.cookie, "list", { path: "escolas/unit-7/acoes", where: ["unidade", "==", "u1"] });
  const w2 = await db(rj.cookie, "list", { path: "escolas/unit-7/acoes", where: ["unidade", "==", "outra"] });
  ok("filtro where funciona", w.json.docs.length === 1 && w2.json.docs.length === 0);
  const t1 = w.json.token, t2 = (await db(rj.cookie, "list", { path: "escolas/unit-7/acoes", where: ["unidade", "==", "u1"], since: t1 })).json;
  ok("polling sem mudança devolve unchanged", t2.unchanged === true);
  ok("caminho com .. recusado", (await db(rj.cookie, "get", { path: "data/users/cms-11/../cms-1/fu-teste" })).status === 400);
  ok("coleção desconhecida bloqueada", (await db(f.cookie, "get", { path: "segredos/x" })).status === 403);
  ok("documento grande demais: quota_exceeded", ((await db(rj.cookie, "set", { path: "data/users/cms-11/big", data: { x: "a".repeat(1000 * 1024) } })).json || {}).code === "quota_exceeded");
  ok("unidades: só franqueador", (await req("/api/unidades", { cookie: rj.cookie, accept: "application/json" })).status === 403 && (await req("/api/unidades", { cookie: f.cookie, accept: "application/json" })).status === 200);

  // 6. token inválido
  const inv = await req("/", { cookie: "gv_session=mock.invalido" });
  ok("token inválido volta ao login", inv.status === 302 && /\/login/.test(inv.loc) && /Max-Age=0/.test(inv.setCookie || ""), String(inv.status));

  // 7. logout
  const lo = await req("/auth/logout", { cookie: rj.cookie, method: "POST", body: {} });
  ok("logout apaga o cookie", /gv_session=;/.test(lo.setCookie || "") && /Max-Age=0/.test(lo.setCookie || ""));

  // 8. CMS fora do ar (opcional)
  if (process.env.MOCK_PID) {
    process.kill(Number(process.env.MOCK_PID));
    await new Promise(r => setTimeout(r, Number(process.env.ESPERA_MS || 2000)));
    const down = await req("/", { cookie: f.cookie });
    const downApi = await req("/api/session", { cookie: f.cookie, accept: "application/json" });
    ok("CMS fora do ar com cache vencido: 503, não libera", down.status === 503 && downApi.status === 503 && !down.txt.includes("GV_SESSION"), `${down.status}/${downApi.status}`);
  }
  console.log(falhas ? `\n${falhas} FALHA(S)` : "\nTODOS OS TESTES PASSARAM");
  process.exit(falhas ? 1 : 0);
})();
