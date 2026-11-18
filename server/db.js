// Acesso ao Postgres e REGRAS DE ACESSO por coleção (aplicadas no servidor).
// Derivadas do inventário do STACK.md, seção 6.
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LIMITE_DOC_BYTES = 900 * 1024;        // por documento
export const LIMITE_PESSOA_BYTES = 60 * 1024 * 1024; // por pessoa (data/users/<id>)

let pool = null;
export function getPool() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL não definido");
  const ssl = /sslmode=require/.test(url) || process.env.PGSSL === "1" ? { rejectUnauthorized: false } : undefined;
  pool = new pg.Pool({ connectionString: url, ssl, max: 10 });
  return pool;
}

export async function migrar() {
  const dir = path.join(__dirname, "migrations");
  const arquivos = fs.readdirSync(dir).filter(f => f.endsWith(".sql")).sort();
  for (const f of arquivos) await getPool().query(fs.readFileSync(path.join(dir, f), "utf8"));
}

export class ErroDb extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

// ---------- caminhos ----------
export function partes(p) {
  if (typeof p !== "string" || !p || p.length > 400) throw new ErroDb("invalid_argument", "Caminho inválido.");
  const s = p.split("/");
  if (s.some(x => !x || x === "." || x === ".." || x.length > 150)) throw new ErroDb("invalid_argument", "Caminho inválido.");
  return s;
}
const ehDoc = s => s.length % 2 === 0;
const paiDe = s => s.slice(0, -1).join("/");

// ---------- regras ----------
// id = identidade do roles.js; seg = segmentos do caminho (doc ou coleção); op = "read" | "write" | "list"
const COMPARTILHADAS = new Set(["pedidos", "relatorios", "monitor", "horarios", "proprios", "dicas", "palavras"]);
const GLOBAIS_MASTER_ESCREVE = new Set(["config", "fontes", "vendedor"]);

export function pode(id, seg, op) {
  if (!id || !id.ok || id.pendente) return false;
  const raiz = seg[0];
  // dados privados da pessoa: data/users/<pessoa>/...
  if (raiz === "data") {
    return seg[1] === "users" && seg.length >= 3 && seg[2] === id.pessoaId;
  }
  // resumo da equipe: cada um escreve o seu; só o franqueador lista e lê todos
  if (raiz === "equipe") {
    if (seg.length === 1) return op === "list" && id.master;
    if (seg.length === 2) return seg[1] === id.pessoaId || (id.master && op === "read");
    return false;
  }
  // GeoFunil: espaço por unidade do CMS
  if (raiz === "escolas") {
    if (seg.length === 1) return op === "list" && id.master;
    return id.master || seg[1] === id.espaco;
  }
  if (GLOBAIS_MASTER_ESCREVE.has(raiz)) return op === "write" ? id.editaBase : true;
  if (COMPARTILHADAS.has(raiz)) return true; // comportamento atual: compartilhado entre todos os usuários logados
  return false; // coleção desconhecida: bloqueada
}

function exigir(id, seg, op) {
  if (!pode(id, seg, op)) throw new ErroDb("permission_denied", "Sem permissão para este dado.", 403);
}

// ---------- operações ----------
export async function getDoc(id, p) {
  const s = partes(p); if (!ehDoc(s)) throw new ErroDb("invalid_argument", "Caminho de documento inválido.");
  exigir(id, s, "read");
  const r = await getPool().query("SELECT dados, versao FROM docs WHERE path=$1", [p]);
  return r.rows[0] ? { exists: true, id: s[s.length - 1], data: r.rows[0].dados, versao: Number(r.rows[0].versao) } : { exists: false, id: s[s.length - 1], data: null, versao: 0 };
}

// lista uma coleção; filtro opcional [campo, "==", valor]; token = "<max versão>:<qtde>" para o polling
export async function listar(id, p, where, desde) {
  const s = partes(p); if (ehDoc(s)) throw new ErroDb("invalid_argument", "Caminho de coleção inválido.");
  exigir(id, s.length === 1 ? s : s, s.length === 1 ? "list" : "read");
  const args = [p]; let filtro = "";
  if (where) {
    if (!Array.isArray(where) || where.length !== 3 || where[1] !== "==" || typeof where[0] !== "string" || !/^[\w.]{1,60}$/.test(where[0]))
      throw new ErroDb("invalid_argument", "Filtro não suportado.");
    args.push(where[0], JSON.stringify(where[2]));
    filtro = " AND (dados #> string_to_array($2, '.')) = $3::jsonb";
  }
  const meta = await getPool().query(`SELECT coalesce(max(versao),0) AS v, count(*) AS n FROM docs WHERE colecao=$1${filtro}`, args);
  const token = meta.rows[0].v + ":" + meta.rows[0].n;
  if (desde && desde === token) return { token, unchanged: true };
  const r = await getPool().query(`SELECT path, dados FROM docs WHERE colecao=$1${filtro} ORDER BY path`, args);
  // franqueador listando a raiz "escolas"/"equipe": tudo; os demais já foram barrados acima
  const docs = r.rows.map(x => ({ id: x.path.split("/").pop(), data: x.dados }))
    .filter(d => pode(id, [...s, d.id], "read"));
  return { token, docs };
}

async function cotaPessoa(id, s, bytesNovos) {
  if (s[0] !== "data") return;
  const r = await getPool().query("SELECT coalesce(sum(octet_length(dados::text)),0) AS b FROM docs WHERE path LIKE $1", ["data/users/" + id.pessoaId + "/%"]);
  if (Number(r.rows[0].b) + bytesNovos > LIMITE_PESSOA_BYTES) throw new ErroDb("quota_exceeded", "Limite de armazenamento atingido.", 413);
}

export async function setDoc(id, p, dados) {
  const s = partes(p); if (!ehDoc(s)) throw new ErroDb("invalid_argument", "Caminho de documento inválido.");
  exigir(id, s, "write");
  if (!dados || typeof dados !== "object" || Array.isArray(dados)) throw new ErroDb("invalid_argument", "Documento inválido.");
  const txt = JSON.stringify(dados);
  if (Buffer.byteLength(txt) > LIMITE_DOC_BYTES) throw new ErroDb("quota_exceeded", "Documento grande demais.", 413);
  await cotaPessoa(id, s, Buffer.byteLength(txt));
  await getPool().query(
    `INSERT INTO docs(path, colecao, dados, versao, atualizado_em, autor) VALUES ($1,$2,$3::jsonb,nextval('docs_versao_seq'),now(),$4)
     ON CONFLICT (path) DO UPDATE SET dados=EXCLUDED.dados, versao=EXCLUDED.versao, atualizado_em=now(), autor=EXCLUDED.autor`,
    [p, paiDe(s), txt, id.pessoaId]);
  return { ok: true };
}

export async function updateDoc(id, p, campos) {
  const s = partes(p); if (!ehDoc(s)) throw new ErroDb("invalid_argument", "Caminho de documento inválido.");
  exigir(id, s, "write");
  if (!campos || typeof campos !== "object" || Array.isArray(campos)) throw new ErroDb("invalid_argument", "Campos inválidos.");
  const r = await getPool().query("SELECT dados FROM docs WHERE path=$1", [p]);
  if (!r.rows[0]) throw new ErroDb("not_found", "Documento não encontrado.", 404);
  return setDoc(id, p, Object.assign({}, r.rows[0].dados, campos));
}

export async function delDoc(id, p) {
  const s = partes(p); if (!ehDoc(s)) throw new ErroDb("invalid_argument", "Caminho de documento inválido.");
  exigir(id, s, "write");
  await getPool().query("DELETE FROM docs WHERE path=$1", [p]);
  // deixa um rastro de versão para o polling perceber a exclusão
  await getPool().query("SELECT nextval('docs_versao_seq')");
  return { ok: true };
}

// ---------- pessoas, unidades e acessos ----------
export async function registrarPessoa({ pessoaId, email, nome, perfil }) {
  await getPool().query(
    `INSERT INTO pessoas(id,nome,email,perfil_cms,ultimo_login) VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (id) DO UPDATE SET nome=coalesce(EXCLUDED.nome,pessoas.nome), email=EXCLUDED.email,
       perfil_cms=coalesce(EXCLUDED.perfil_cms,pessoas.perfil_cms), ultimo_login=now()`,
    [pessoaId, nome || null, String(email).toLowerCase(), perfil || null]);
}

// modo "admin": registra a pessoa e a unidade que o CMS devolveu (a unidade só preenche campos ainda vazios,
// para não apagar correções do franqueador feitas em /acessos)
export async function registrarDoCms(me, uf) {
  const u = (me && me.user) || {}, un = (me && me.unit) || null;
  await getPool().query(
    `INSERT INTO pessoas(id,nome,email,role_id,unit_id,perfil_cms,ultimo_login) VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (id) DO UPDATE SET nome=EXCLUDED.nome, email=EXCLUDED.email, role_id=EXCLUDED.role_id, unit_id=EXCLUDED.unit_id, perfil_cms=EXCLUDED.perfil_cms, ultimo_login=now()`,
    ["cms-" + u.id, u.name || u.nickname || null, u.email ? String(u.email).toLowerCase() : null, u.role_id ?? null, u.unit_id ?? null, u.role || null]);
  if (un && un.id != null) {
    await getPool().query(
      `INSERT INTO unidades(unit_id,nome,uf,cidade) VALUES ($1,$2,$3,$4)
       ON CONFLICT (unit_id) DO UPDATE SET nome=coalesce(unidades.nome,EXCLUDED.nome), uf=coalesce(unidades.uf,EXCLUDED.uf), cidade=coalesce(unidades.cidade,EXCLUDED.cidade)`,
      [Number(un.id), un.name || null, uf || null, un.city || null]);
  }
}
export async function dePara(unitId) {
  if (unitId == null) return null;
  const r = await getPool().query("SELECT unit_id, nome, uf, cidade FROM unidades WHERE unit_id=$1", [Number(unitId)]);
  return r.rows[0] || null;
}
export async function painelUnidadesCms() {
  const [u, p] = await Promise.all([
    getPool().query(`SELECT u.unit_id, u.nome, u.uf, u.cidade, (SELECT count(*) FROM pessoas p WHERE p.unit_id=u.unit_id) AS pessoas
                       FROM unidades u ORDER BY u.nome NULLS LAST, u.unit_id`),
    getPool().query(`SELECT email, nome, perfil_cms, role_id, unit_id, ultimo_login FROM pessoas WHERE role_id IS NOT NULL ORDER BY ultimo_login DESC NULLS LAST LIMIT 200`),
  ]);
  return { unidades: u.rows, pessoas: p.rows };
}

export async function acessoDe(email) {
  const r = await getPool().query(
    `SELECT a.email, a.papel, a.unit_id, a.ativo, u.nome AS unidade_nome, u.uf, u.cidade
       FROM acessos a LEFT JOIN unidades u ON u.unit_id = a.unit_id WHERE a.email = $1`, [String(email || "").toLowerCase()]);
  return r.rows[0] || null;
}

export async function nomePessoa(pessoaId) {
  const r = await getPool().query("SELECT nome FROM pessoas WHERE id=$1", [pessoaId]);
  return r.rows[0] ? r.rows[0].nome : null;
}

export async function painelAcessos() {
  const [u, a, p] = await Promise.all([
    getPool().query(`SELECT u.unit_id, u.nome, u.uf, u.cidade, (SELECT count(*) FROM acessos a WHERE a.unit_id=u.unit_id) AS pessoas
                       FROM unidades u ORDER BY u.nome NULLS LAST, u.unit_id`),
    getPool().query(`SELECT a.email, a.papel, a.unit_id, a.ativo, p.nome, p.perfil_cms, p.ultimo_login
                       FROM acessos a LEFT JOIN pessoas p ON lower(p.email) = a.email ORDER BY a.papel, a.email`),
    getPool().query(`SELECT p.email, p.nome, p.perfil_cms, p.ultimo_login FROM pessoas p
                      WHERE p.email IS NOT NULL AND NOT EXISTS (SELECT 1 FROM acessos a WHERE a.email = lower(p.email))
                      ORDER BY p.ultimo_login DESC NULLS LAST LIMIT 100`),
  ]);
  return { unidades: u.rows, acessos: a.rows, pendentes: p.rows };
}

function validarUnidade({ nome, uf, cidade }) {
  const N = String(nome || "").trim(), UF = String(uf || "").trim().toUpperCase();
  if (!N) throw new ErroDb("invalid_argument", "Informe o nome da unidade.");
  if (!/^[A-Z]{2}$/.test(UF)) throw new ErroDb("invalid_argument", "UF inválida.");
  return [N.slice(0, 120), UF, String(cidade || "").trim().slice(0, 120) || null];
}
export async function criarUnidade(dados) {
  const [n, uf, c] = validarUnidade(dados);
  const r = await getPool().query("INSERT INTO unidades(nome,uf,cidade) VALUES ($1,$2,$3) RETURNING unit_id", [n, uf, c]);
  return { unit_id: r.rows[0].unit_id };
}
export async function salvarUnidade(unitId, dados) {
  const [n, uf, c] = validarUnidade(dados);
  const r = await getPool().query("UPDATE unidades SET nome=$2, uf=$3, cidade=$4, atualizado_em=now() WHERE unit_id=$1", [Number(unitId), n, uf, c]);
  if (!r.rowCount) throw new ErroDb("not_found", "Unidade não encontrada.", 404);
}

export async function salvarAcesso(email, { papel, unit_id, ativo }, autor) {
  const E = String(email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(E)) throw new ErroDb("invalid_argument", "E-mail inválido.");
  if (!["franqueador", "master"].includes(papel)) throw new ErroDb("invalid_argument", "Papel inválido.");
  const U = papel === "master" ? Number(unit_id) : null;
  if (papel === "master") {
    if (!U) throw new ErroDb("invalid_argument", "Escolha a unidade do master.");
    const ex = await getPool().query("SELECT 1 FROM unidades WHERE unit_id=$1", [U]);
    if (!ex.rowCount) throw new ErroDb("invalid_argument", "Unidade não encontrada.");
  }
  await getPool().query(
    `INSERT INTO acessos(email,papel,unit_id,ativo,criado_por) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (email) DO UPDATE SET papel=EXCLUDED.papel, unit_id=EXCLUDED.unit_id, ativo=EXCLUDED.ativo`,
    [E, papel, U, ativo !== false, autor || null]);
}
export async function removerAcesso(email) {
  await getPool().query("DELETE FROM acessos WHERE email=$1", [String(email || "").trim().toLowerCase()]);
  await getPool().query("DELETE FROM sessoes WHERE lower(email)=$1", [String(email || "").trim().toLowerCase()]);
}

export async function perfis(ids) {
  const lista = (Array.isArray(ids) ? ids : []).filter(x => typeof x === "string").slice(0, 200);
  if (!lista.length) return {};
  const r = await getPool().query("SELECT id, nome FROM pessoas WHERE id = ANY($1)", [lista]);
  const out = {};
  r.rows.forEach(x => { out[x.id] = { id: x.id, name: x.nome || "Usuário", avatarUrl: null }; });
  return out;
}
