// Matriz de testes de acesso (README e AGENTS.md). Rode com o servidor e o CMS falso no ar:
//   GV_FRANQUEADORES=franqueador@teste.com no servidor, depois  BASE=http://localhost:8080 node server/dev/test-matrix.js
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

  // 2. credenciais
  const errada = await login("master.rj@teste.com", "x");
  ok("senha errada: mensagem, sem cookie", errada.r.status === 401 && !errada.cookie && /incorretos/.test(errada.r.json.message), errada.r.json && errada.r.json.message);
  const naoExiste = await login("ninguem@teste.com");
  ok("e-mail inexistente: mesma mensagem, sem cookie", naoExiste.r.status === 401 && !naoExiste.cookie && /incorretos/.test(naoExiste.r.json.message));
  const des = await login("desativado@teste.com");
  ok("desativado no CMS: recusado", des.r.status === 401 && !des.cookie && /desativado/i.test(des.r.json.message), des.r.json && des.r.json.message);

  // 3. franqueador (definido em GV_FRANQUEADORES)
  const f = await login("franqueador@teste.com");
  ok("franqueador entra", !!f.cookie, String(f.r.status) + " " + (f.r.json && f.r.json.message));
  ok("cookie é id aleatório (não é o token do CMS)", /^[a-f0-9]{64}$/.test(f.valor || "") && /HttpOnly/.test(f.r.setCookie) && /SameSite=Lax/.test(f.r.setCookie));
  const sf = await api(f.cookie, "GET", "/api/session");
  ok("franqueador: papel master (vê tudo)", sf.json && sf.json.master === true && sf.json.pendente === false, JSON.stringify(sf.json && { papel: sf.json.papel, rotulo: sf.json.rotulo }));
  const app = await req("/", { cookie: f.cookie });
  ok("app servido com sessão e shim antes do código", app.status === 200 && app.txt.includes("window.GV_SESSION=") && app.txt.indexOf("claude-shim.js") < app.txt.indexOf("/* PDFs do GeoVenda") && !app.txt.includes("mock.") && !/eyJ[\w-]+\.eyJ/.test(app.txt));
  ok("franqueador lê templates.js e qualquer UF", (await req("/templates.js", { cookie: f.cookie, accept: "*/*" })).status === 200 && (await req("/data/AL.json", { cookie: f.cookie, accept: "*/*" })).status === 200);
  ok("franqueador abre /acessos", (await req("/acessos", { cookie: f.cookie })).status === 200);

  // 4. sem acesso liberado: master novo e professor
  const novo = await login("master.novo@teste.com");
  ok("master sem acesso liberado: 403, sem cookie", novo.r.status === 403 && !novo.cookie && /não foi liberado/.test(novo.r.json.message), novo.r.json && novo.r.json.message);
  const prof = await login("professor@teste.com");
  ok("professor: 403, sem cookie", prof.r.status === 403 && !prof.cookie);
  const painel = await api(f.cookie, "GET", "/api/acessos");
  const pend = (painel.json && painel.json.pendentes || []).map(p => p.email);
  ok("tentativas aparecem como pendentes para o franqueador", pend.includes("master.novo@teste.com") && pend.includes("professor@teste.com"), pend.join(", "));
  ok("perfil do CMS registrado", (painel.json.pendentes.find(p => p.email === "professor@teste.com") || {}).perfil_cms === "Professor");

  // 5. franqueador cria unidade e libera o master
  const un = await api(f.cookie, "POST", "/api/unidades", { nome: "Top English Niterói", uf: "rj", cidade: "Niterói" });
  ok("cria unidade", un.status === 200 && un.json.unit_id > 0, JSON.stringify(un.json));
  ok("UF inválida recusada", (await api(f.cookie, "POST", "/api/unidades", { nome: "X", uf: "R1" })).status === 400);
  ok("master sem unidade recusado", (await api(f.cookie, "PUT", "/api/acessos/master.rj@teste.com", { papel: "master" })).status === 400);
  ok("libera master na unidade", (await api(f.cookie, "PUT", "/api/acessos/master.rj@teste.com", { papel: "master", unit_id: un.json.unit_id })).status === 200);
  const rj = await login("master.rj@teste.com");
  const srj = await api(rj.cookie, "GET", "/api/session");
  ok("master entra travado na unidade e UF", srj.json && srj.json.master === false && srj.json.unidade.uf === "RJ" && srj.json.espaco === "unit-" + un.json.unit_id, JSON.stringify(srj.json && srj.json.unidade));
  ok("master recebe a UF dele", (await req("/data/RJ.json", { cookie: rj.cookie, accept: "*/*" })).status === 200);
  ok("master não recebe outra UF", (await req("/data/AL.json", { cookie: rj.cookie, accept: "*/*" })).status === 403 && (await req("/bairros/SP.json", { cookie: rj.cookie, accept: "*/*" })).status === 403);
  ok("master não abre /acessos nem a API de acessos", (await req("/acessos", { cookie: rj.cookie })).status === 403 && (await api(rj.cookie, "GET", "/api/acessos")).status === 403);
  ok("master não se promove", (await api(rj.cookie, "PUT", "/api/acessos/master.rj@teste.com", { papel: "franqueador" })).status === 403);
  ok("franqueador não remove o próprio acesso", (await api(f.cookie, "DELETE", "/api/acessos/franqueador@teste.com")).status === 400);

  // 6. arquivos fora de public/
  for (const p of ["/server/server.js", "/.env", "/STACK.md", "/docs/GUIA_INTEGRACAO_FRONT_API.md", "/../package.json", "/%2e%2e/package.json", "/package.json", "/server/dev/mock-cms.js", "/server/paginas/acessos.html"]) {
    const r = await req(p, { cookie: f.cookie, accept: "*/*" });
    ok("logado não acessa " + p, [400, 403, 404].includes(r.status) && !/import |CMS_BASE_URL|"dependencies"/.test(r.txt), String(r.status));
  }

  // 7. regras de dados
  await db(f.cookie, "set", { path: "data/users/cms-1/fu-teste", data: { id: "fu-teste", nome: "lead", status: "andamento", passos: [], historico: [] } });
  ok("usuário A não lê privado de B", (await db(rj.cookie, "get", { path: "data/users/cms-1/fu-teste" })).status === 403);
  ok("usuário grava e lê o próprio", (await db(rj.cookie, "set", { path: "data/users/cms-11/fu-1", data: { id: "fu-1", nome: "Lead RJ", status: "andamento", passos: [], historico: [] } })).status === 200 && ((await db(rj.cookie, "get", { path: "data/users/cms-11/fu-1" })).json || {}).data?.nome === "Lead RJ");
  ok("master não escreve em config/*", (await db(rj.cookie, "set", { path: "config/calibracao", data: { x: 1 } })).status === 403);
  ok("master não escreve vendedor/metodo", (await db(rj.cookie, "set", { path: "vendedor/metodo", data: { texto: "x" } })).status === 403);
  ok("franqueador escreve vendedor/metodo e master lê", (await db(f.cookie, "set", { path: "vendedor/metodo", data: { texto: "Método PROBAC" } })).status === 200 && ((await db(rj.cookie, "get", { path: "vendedor/metodo" })).json || {}).data?.texto === "Método PROBAC");
  const esp = srj.json.espaco;
  ok("master grava no espaço da unidade", (await db(rj.cookie, "set", { path: `escolas/${esp}/acoes/a1`, data: { unidade: "u1", titulo: "Aula aberta" } })).status === 200);
  ok("master não lê espaço de outra unidade", (await db(rj.cookie, "list", { path: "escolas/unit-999/acoes" })).status === 403);
  ok("master não lista escolas nem equipe", (await db(rj.cookie, "list", { path: "escolas" })).status === 403 && (await db(rj.cookie, "list", { path: "equipe" })).status === 403);
  ok("franqueador lê espaço da unidade", ((await db(f.cookie, "list", { path: `escolas/${esp}/acoes` })).json || {}).docs?.length === 1);
  const w = await db(rj.cookie, "list", { path: `escolas/${esp}/acoes`, where: ["unidade", "==", "u1"] });
  ok("filtro where e polling", w.json.docs.length === 1 && (await db(rj.cookie, "list", { path: `escolas/${esp}/acoes`, where: ["unidade", "==", "u1"], since: w.json.token })).json.unchanged === true);
  ok("caminho com .. recusado", (await db(rj.cookie, "get", { path: "data/users/cms-11/../cms-1/fu-teste" })).status === 400);
  ok("coleção desconhecida bloqueada", (await db(f.cookie, "get", { path: "segredos/x" })).status === 403);
  ok("documento grande: quota_exceeded", ((await db(rj.cookie, "set", { path: "data/users/cms-11/big", data: { x: "a".repeat(1000 * 1024) } })).json || {}).code === "quota_exceeded");

  // 8. revogação imediata
  ok("franqueador desativa o master", (await api(f.cookie, "PUT", "/api/acessos/master.rj@teste.com", { papel: "master", unit_id: un.json.unit_id, ativo: false })).status === 200);
  const depois = await api(rj.cookie, "GET", "/api/session");
  ok("master desativado perde o acesso na hora", depois.status === 403, String(depois.status));
  await api(f.cookie, "PUT", "/api/acessos/master.rj@teste.com", { papel: "master", unit_id: un.json.unit_id, ativo: true });
  const rj2 = await login("master.rj@teste.com");
  ok("reativado entra de novo", !!rj2.cookie);
  ok("remover acesso derruba a sessão", (await api(f.cookie, "DELETE", "/api/acessos/master.rj@teste.com")).status === 200 && (await api(rj2.cookie, "GET", "/api/session")).status === 401);

  // 9. cookie falso e logout
  const inv = await req("/", { cookie: "gv_session=" + "a".repeat(64) });
  ok("cookie falso volta ao login", inv.status === 302 && /\/login/.test(inv.loc));
  ok("token do CMS no cookie não é aceito", (await req("/", { cookie: "gv_session=eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoxfQ.x" })).status === 302);
  const f2 = await login("franqueador@teste.com");
  const lo = await req("/auth/logout", { cookie: f2.cookie, method: "POST", body: {} });
  ok("logout apaga o cookie e a sessão", /Max-Age=0/.test(lo.setCookie || "") && (await req("/", { cookie: f2.cookie })).status === 302);

  // 10. CMS fora do ar (opcional)
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
