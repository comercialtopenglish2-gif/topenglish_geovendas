// CMS FALSO no formato da API de PRODUÇÃO (docs/GUIA_INTEGRACAO_FRONT_API.md). Só para testes locais.
// Usuários (senha de todos: teste123):
//   franqueador@teste.com (role 1) · master.rj@teste.com (role 2) · master.novo@teste.com (role 2, sem acesso liberado)
//   professor@teste.com (role 3) · desativado@teste.com (desativado)
// Login v2 confere a assinatura HS256 com MOCK_PASSWORD_SECRET (padrão "segredo-de-teste").
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.MOCK_CMS_PORT || 4000);
const SEGREDO = process.env.MOCK_PASSWORD_SECRET || "segredo-de-teste";
const JWT_SECRET = "jwt-falso";
const USERS = [
  { id: 1, email: "franqueador@teste.com", nickname: "Diretoria", role: "Franqueador", status: "ativado" },
  { id: 11, email: "master.rj@teste.com", nickname: "Rita", role: "Master Franqueado", status: "ativado" },
  { id: 12, email: "master.novo@teste.com", nickname: "Novo", role: "Master Franqueado", status: "ativado" },
  { id: 20, email: "professor@teste.com", nickname: "Prof. Ana", role: "Professor", status: "ativado" },
  { id: 30, email: "desativado@teste.com", nickname: "Ex", role: "Master Franqueado", status: "desativado" },
];
const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwt(payload, segredo) { const h = b64({ alg: "HS256", typ: "JWT" }), p = b64(payload); return `${h}.${p}.` + crypto.createHmac("sha256", segredo).update(h + "." + p).digest("base64url"); }
function verificar(token, segredo) {
  const [h, p, s] = String(token).split(".");
  if (!s || crypto.createHmac("sha256", segredo).update(h + "." + p).digest("base64url") !== s) return null;
  try { return JSON.parse(Buffer.from(p, "base64url").toString()); } catch { return null; }
}
const ttl = () => Number(process.env.MOCK_TTL_S || 86400);
function autenticar(email, senha) {
  const u = USERS.find(x => x.email === String(email || "").trim().toLowerCase());
  if (!u) return { erro: "User not found." };
  if (u.status === "desativado") return { erro: "User desactivated." };
  if (senha !== "teste123") return { erro: "Password is incorrect." };
  return { u, token: jwt({ user_id: u.id, typ: "teacher", exp: Math.floor(Date.now() / 1000) + ttl() }, JWT_SECRET) };
}
const json = (res, st, b) => { res.writeHead(st, { "Content-Type": "application/json" }); res.end(JSON.stringify(b)); };
const corpo = req => new Promise(ok => { let b = ""; req.on("data", c => b += c); req.on("end", () => { try { ok(JSON.parse(b || "{}")); } catch { ok({}); } }); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/v1/authentication.json" || url.pathname === "/v1/authentication") {
    const r = autenticar(url.searchParams.get("email"), url.searchParams.get("pass"));
    return r.erro ? json(res, 200, { status: "ERROR", message: r.erro }) : json(res, 200, { token: r.token, token_auth: r.token });
  }
  if ((url.pathname === "/v2/webbook/login.json" || url.pathname === "/v2/webbook/login") && req.method === "POST") {
    const b = await corpo(req), p = verificar(b.payload, SEGREDO);
    if (!p) return json(res, 401, { status: "ERROR", message: "Invalid payload." });
    const r = autenticar(p.email, p.password);
    return r.erro ? json(res, 401, { status: "ERROR", message: r.erro })
      : json(res, 200, { status: "SUCCESS", message: "Login ok", content: { name: r.u.nickname, email: r.u.email, token: r.token, token_auth: r.token, image: { url: "", thumb: "" } } });
  }
  if (url.pathname === "/webbook/teacher/dashboard") {
    const t = String(req.headers.authorization || "").replace(/^Bearer /, "");
    const p = verificar(t, JWT_SECRET);
    if (!p || p.exp * 1000 < Date.now()) return json(res, 401, { status: "ERROR", message: "Invalid Payload", type: "error", code: 101 });
    const u = USERS.find(x => x.id === p.user_id);
    // como pode acontecer na produção: o dashboard do webbook falha para quem não é professor
    if (u.role === "Franqueador") return json(res, 500, { status: "ERROR", message: "undefined method for nil", type: "error", code: 500 });
    return json(res, 200, { status: "SUCCESS", message: "", content: { role: u.role, agenda: [], totais: {} } });
  }
  if (url.pathname === "/v1/enrollment.json" || url.pathname === "/v1/enrollment") {
    const t = String(req.headers.authorization || "").replace(/^Bearer /, "") || url.searchParams.get("token");
    const p = verificar(t, JWT_SECRET);
    if (!p || p.exp * 1000 < Date.now()) return json(res, 401, { status: "ERROR", message: "Invalid Payload", type: "error", code: 101 });
    return json(res, 200, []);
  }
  json(res, 404, { status: "ERROR", message: "Not found" });
}).listen(PORT, () => console.log("CMS falso (produção) em http://localhost:" + PORT));
