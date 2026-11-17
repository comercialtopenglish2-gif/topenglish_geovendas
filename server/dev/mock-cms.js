// CMS FALSO para testes locais. Nunca vai para produção (fora do Docker via .dockerignore).
// Usuários de teste (senha de todos: teste123):
//   franqueador@teste.com (role 1) · master@teste.com (role 2, unidade 4 sem UF) ·
//   master.rj@teste.com (role 2, unidade 7 com UF RJ) · professor@teste.com (role 3) · desativado@teste.com
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.MOCK_CMS_PORT || 4000);
const USERS = [
  { id: 1, email: "franqueador@teste.com", nickname: "Diretoria", role_id: 1, unit_id: null, status: "ativado" },
  { id: 10, email: "master@teste.com", nickname: "Marcos", role_id: 2, unit_id: 4, status: "ativado" },
  { id: 11, email: "master.rj@teste.com", nickname: "Rita", role_id: 2, unit_id: 7, status: "ativado" },
  { id: 20, email: "professor@teste.com", nickname: "Prof. Ana", role_id: 3, unit_id: 4, status: "ativado" },
  { id: 30, email: "desativado@teste.com", nickname: "Ex", role_id: 2, unit_id: 4, status: "Desativado" },
];
const UNITS = { 4: { id: 4, name: "Recife Sul", status: null, region: null, city: null, state: null }, 7: { id: 7, name: "Niterói", status: null, region: null, city: "Niterói", state: "RJ" } };
const ROLE = { 1: "Franqueador", 2: "Master Franqueado", 3: "Professor" };
const tokens = new Map(); // token -> { userId, exp }

function json(res, status, body) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); }
function corpo(req) { return new Promise(ok => { let b = ""; req.on("data", c => b += c); req.on("end", () => { try { ok(JSON.parse(b || "{}")); } catch { ok({}); } }); }); }

const srv = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/admin/health") return json(res, 200, { status: "ok", service: "topenglish-admin-api (mock)" });
  if (url.pathname === "/admin/auth/login" && req.method === "POST") {
    const b = await corpo(req);
    const email = String(b.email || "").trim().toLowerCase();
    const u = USERS.find(x => x.email === email);
    if (!u || b.password !== "teste123") return json(res, 401, { error: "unauthorized", message: "E-mail ou senha inválidos." });
    if (String(u.status).toLowerCase() === "desativado") return json(res, 403, { error: "forbidden", message: "Usuário desativado." });
    if (![1, 2, 3].includes(u.role_id)) return json(res, 403, { error: "forbidden", message: "Perfil sem acesso ao Admin." });
    const token = "mock." + crypto.randomBytes(16).toString("hex");
    const ttl = Number(process.env.MOCK_TTL_S || 86400);
    tokens.set(token, { userId: u.id, exp: Date.now() + ttl * 1000 });
    return json(res, 200, { token, token_type: "Bearer", expires_in_hours: 24,
      user: { id: u.id, name: u.nickname || u.email, email: u.email, role_id: u.role_id, role: ROLE[u.role_id], unit_id: u.unit_id, status: u.status },
      unit: u.unit_id ? UNITS[u.unit_id] : null });
  }
  if (url.pathname === "/admin/auth/me") {
    const t = String(req.headers.authorization || "").replace(/^Bearer /, "");
    const s = tokens.get(t);
    if (!s || s.exp < Date.now()) return json(res, 401, { error: "unauthorized", message: "Token inválido ou expirado." });
    const u = USERS.find(x => x.id === s.userId);
    return json(res, 200, { user: { id: u.id, role_id: u.role_id, unit_id: u.unit_id }, unit: u.unit_id ? { id: u.unit_id, name: UNITS[u.unit_id].name } : null,
      capabilities: { mgmt: u.role_id <= 2, super_admin: u.role_id === 1, teacher_portal: u.role_id === 3 } });
  }
  json(res, 404, { error: "not_found" });
});
srv.listen(PORT, () => console.log("CMS falso em http://localhost:" + PORT));
