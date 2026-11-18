// Matriz de testes de acesso no modo "admin" (API /admin do CMS, docs/INTEGRACAO_API_FRONT.md).
// Rode com o servidor (CMS_API=admin, o padrão) e o CMS falso no ar:  BASE=http://localhost:8080 node server/dev/test-matrix.js
// Para o modo "legado", use server/dev/test-matrix-legado.js (servidor com CMS_API=legado e GV_FRANQUEADORES=franqueador@teste.com).
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
async function login(email, password = SENHA) {
  const r = await req("/auth/login", { method: "POST", body: { email, password } });
  const c = r.setCookie && r.setCookie.match(/gv_session=([^;]*)/);
  return { r, cookie: c && c[1] ? "gv_session=" + c[1] : null, valor: c && c[1] };
}
const db = (cookie, op, body) => req("/api/db/" + op, { cookie, method: "POST", body, accept: "application/json" });
const api = (cookie, method, caminho, body) => req(caminho, { cookie, method, body, accept: "application/json" });

(async () => {
  // 1. sem login nada abre
  for (const p of ["/", "/index.html", "/templates.js", "/data/AL.json", "/bairros/AL.json", "/claude-shim.js", "/acessos"]) {
    const h = await req(p); const j = await req(p, { accept: "application/json" });
    ok("sem login " + p, (h.status === 302 && /^\/login/.test(new URL(h.loc, BASE).pathname)) && j.status === 401 && !/GF_TPL|"vb"|<html/i.test(h.txt + j.txt), `html ${h.status}, json ${j.status}`);
  }
  ok("sem login /api/session", (await req("/api/session", { accept: "application/json" })).status === 401);
  ok("healthz público", (await req("/healthz", { accept: "application/json" })).status === 200);
  ok("tela de login pública", (await req("/login")).status === 200);
  const nx = await req("/auth/login", { method: "POST", body: { email: "master.rj@teste.com", password: SENHA, next: "//mal.com" } });
  ok("next externo recusado", nx.json && nx.json.next === "/", nx.json && nx.json.next);

  // 2. credenciais e papéis bloqueados
  const errada = await login("master.rj@teste.com", "x");
  ok("senha errada: mensagem, sem cookie", errada.r.status === 401 && !errada.cookie && /incorretos/.test(errada.r.json.message), errada.r.json && errada.r.json.message);
  const prof = await login("professor@teste.com");
  ok("professor (role 3): 403, sem cookie", prof.r.status === 403 && !prof.cookie && /Perfil sem acesso ao GeoVenda/.test(prof.r.json.message), prof.r.json && prof.r.json.message);
  const des = await login("desativado@teste.com");
  ok("desativado recusado pelo CMS", des.r.status === 403 && !des.cookie, des.r.json && des.r.json.message);

  // 3. franqueador (role 1)
  const f = await login("franqueador@teste.com");
  ok("franqueador entra (CMS responde 201)", !!f.cookie, String(f.r.status) + " " + (f.r.json && f.r.json.message));
  ok("cookie é id aleatório, HttpOnly, SameSite=Lax", /^[a-f0-9]{64}$/.test(f.valor || "") && /HttpOnly/.test(f.r.setCookie) && /SameSite=Lax/.test(f.r.setCookie));
  const sf = await api(f.cookie, "GET", "/api/session");
  ok("franqueador vê tudo, com espaço próprio", sf.json && sf.json.master === true && sf.json.pendente === false && sf.json.espaco === "cms-1" && sf.json.pessoa.nome === "Diretoria", JSON.stringify(sf.json && { papel: sf.json.papel, espaco: sf.json.espaco }));
  const app = await req("/", { cookie: f.cookie });
  ok("app servido com sessão e shim antes do código, sem token", app.status === 200 && app.txt.includes("window.GV_SESSION=") && app.txt.indexOf("claude-shim.js") < app.txt.indexOf("/* PDFs do GeoVenda") && !/eyJ[\w-]+\.eyJ/.test(app.txt));
  ok("franqueador lê templates.js e qualquer UF", (await req("/templates.js", { cookie: f.cookie, accept: "*/*" })).status === 200 && (await req("/data/SP.json", { cookie: f.cookie, accept: "*/*" })).status === 200);

  // 4. master (role 2) com estado por extenso no CMS ("Rio de Janeiro" -> RJ)
  const rj = await login("master.rj@teste.com");
  const srj = await api(rj.cookie, "GET", "/api/session");
  ok("master travado na unidade e UF do CMS", srj.json && srj.json.master === false && srj.json.unidade.uf === "RJ" && srj.json.unidade.nome === "Niterói" && srj.json.espaco === "unit-7", JSON.stringify(srj.json && srj.json.unidade));
  ok("master recebe a UF dele", (await req("/data/RJ.json", { cookie: rj.cookie, accept: "*/*" })).status === 200 && (await req("/bairros/RJ.json", { cookie: rj.cookie, accept: "*/*" })).status === 200);
  ok("master não recebe outra UF", (await req("/data/AL.json", { cookie: rj.cookie, accept: "*/*" })).status === 403 && (await req("/bairros/SP.json", { cookie: rj.cookie, accept: "*/*" })).status === 403);
  ok("master recebe estados.json", (await req("/data/estados.json", { cookie: rj.cookie, accept: "*/*" })).status === 200);
  ok("master não abre /acessos", (await req("/acessos", { cookie: rj.cookie })).status === 403 && (await api(rj.cookie, "GET", "/api/acessos")).status === 403);

  // 5. master de unidade sem estado no CMS: pendente até o franqueador corrigir em /acessos
  const novo = await login("master.novo@teste.com");
  const snovo = await api(novo.cookie, "GET", "/api/session");
  ok("unidade sem UF: configuração pendente, sem dados", snovo.json && snovo.json.pendente === true && (await req("/", { cookie: novo.cookie })).status === 403 && (await db(novo.cookie, "get", { path: "vendedor/metodo" })).status === 403);
  const painel = await api(f.cookie, "GET", "/api/acessos");
  ok("painel do franqueador no modo admin", painel.json && painel.json.modo === "admin" && painel.json.unidades.some(u => u.unit_id === 7 && u.uf === "RJ") && painel.json.pessoas.some(p => p.email === "master.rj@teste.com"), JSON.stringify(painel.json && painel.json.unidades));
  ok("modo admin não aceita criar unidade nem papel", (await api(f.cookie, "POST", "/api/unidades", { nome: "X", uf: "SP" })).status === 400 && (await api(f.cookie, "PUT", "/api/acessos/x@y.com", { papel: "master" })).status === 400);
  ok("franqueador corrige a UF da unidade", (await api(f.cookie, "PUT", "/api/unidades/4", { nome: "Recife Sul", uf: "pe", cidade: "Recife" })).status === 200);
  const snovo2 = await api(novo.cookie, "GET", "/api/session");
  ok("master liberado com a UF corrigida", snovo2.json && snovo2.json.pendente === false && snovo2.json.unidade.uf === "PE", JSON.stringify(snovo2.json && snovo2.json.unidade));
  ok("correção do franqueador não é sobrescrita no próximo login", (await login("master.novo@teste.com")).cookie && ((await api(f.cookie, "GET", "/api/acessos")).json.unidades.find(u => u.unit_id === 4) || {}).uf === "PE");

  // 6. arquivos fora de public/
  for (const p of ["/server/server.js", "/.env", "/STACK.md", "/docs/INTEGRACAO_API_FRONT.md", "/../package.json", "/%2e%2e/package.json", "/package.json", "/server/dev/mock-cms.js", "/server/paginas/acessos.html"]) {
    const r = await req(p, { cookie: f.cookie, accept: "*/*" });
    ok("logado não acessa " + p, [400, 403, 404].includes(r.status) && !/import |CMS_BASE_URL|"dependencies"/.test(r.txt), String(r.status));
  }

  // 7. regras de dados
  await db(f.cookie, "set", { path: "data/users/cms-1/fu-teste", data: { id: "fu-teste", nome: "lead", status: "andamento", passos: [], historico: [] } });
  ok("usuário A não lê privado de B", (await db(rj.cookie, "get", { path: "data/users/cms-1/fu-teste" })).status === 403);
  ok("usuário grava e lê o próprio", (await db(rj.cookie, "set", { path: "data/users/cms-11/fu-1", data: { id: "fu-1", nome: "Lead RJ", status: "andamento", passos: [], historico: [] } })).status === 200 && ((await db(rj.cookie, "get", { path: "data/users/cms-11/fu-1" })).json || {}).data?.nome === "Lead RJ");
  ok("master não escreve em config/* nem vendedor/metodo", (await db(rj.cookie, "set", { path: "config/calibracao", data: { x: 1 } })).status === 403 && (await db(rj.cookie, "set", { path: "vendedor/metodo", data: { texto: "x" } })).status === 403);
  ok("franqueador escreve vendedor/metodo e master lê", (await db(f.cookie, "set", { path: "vendedor/metodo", data: { texto: "Método PROBAC" } })).status === 200 && ((await db(rj.cookie, "get", { path: "vendedor/metodo" })).json || {}).data?.texto === "Método PROBAC");
  ok("master grava no espaço da unidade", (await db(rj.cookie, "set", { path: "escolas/unit-7/acoes/a1", data: { unidade: "u1", titulo: "Aula aberta" } })).status === 200);
  ok("master não lê espaço de outra unidade", (await db(rj.cookie, "list", { path: "escolas/unit-4/acoes" })).status === 403);
  ok("master não lista escolas nem equipe", (await db(rj.cookie, "list", { path: "escolas" })).status === 403 && (await db(rj.cookie, "list", { path: "equipe" })).status === 403);
  ok("franqueador lê espaço de qualquer unidade", ((await db(f.cookie, "list", { path: "escolas/unit-7/acoes" })).json || {}).docs?.length === 1);
  const w = await db(rj.cookie, "list", { path: "escolas/unit-7/acoes", where: ["unidade", "==", "u1"] });
  ok("filtro where e polling", w.json.docs.length === 1 && (await db(rj.cookie, "list", { path: "escolas/unit-7/acoes", where: ["unidade", "==", "u1"], since: w.json.token })).json.unchanged === true);
  ok("caminho com .. recusado", (await db(rj.cookie, "get", { path: "data/users/cms-11/../cms-1/fu-teste" })).status === 400);
  ok("coleção desconhecida bloqueada", (await db(f.cookie, "get", { path: "segredos/x" })).status === 403);
  ok("documento grande: quota_exceeded", ((await db(rj.cookie, "set", { path: "data/users/cms-11/big", data: { x: "a".repeat(1000 * 1024) } })).json || {}).code === "quota_exceeded");

  // 8. cookie falso e logout
  ok("cookie falso volta ao login", (await req("/", { cookie: "gv_session=" + "a".repeat(64) })).status === 302);
  ok("token do CMS no cookie não é aceito", (await req("/", { cookie: "gv_session=eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoxfQ.x" })).status === 302);
  const f2 = await login("franqueador@teste.com");
  const lo = await req("/auth/logout", { cookie: f2.cookie, method: "POST", body: {} });
  ok("logout apaga o cookie e a sessão", /Max-Age=0/.test(lo.setCookie || "") && (await req("/", { cookie: f2.cookie })).status === 302);

  // 9. CMS fora do ar (opcional)
  if (process.env.MOCK_PID) {
    process.kill(Number(process.env.MOCK_PID));
    await new Promise(r => setTimeout(r, Number(process.env.ESPERA_MS || 2000)));
    const down = await req("/", { cookie: f.cookie });
    const downApi = await api(f.cookie, "GET", "/api/session");
    ok("CMS fora do ar com cache vencido: 503, não libera", down.status === 503 && downApi.status === 503 && !down.txt.includes("GV_SESSION"), `${down.status}/${downApi.status}`);
    const lg = await login("franqueador@teste.com");
    ok("CMS fora do ar: login recusado sem cookie", !lg.cookie && lg.r.status === 502, String(lg.r.status));
  }
  console.log(falhas ? `\n${falhas} FALHA(S)` : "\nTODOS OS TESTES PASSARAM");
  process.exit(falhas ? 1 : 0);
})();
