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

// ---------- pessoas e unidades ----------
export async function registrarPessoa(me) {
  const u = me.user || {};
  await getPool().query(
    `INSERT INTO pessoas(id,nome,email,role_id,unit_id,ultimo_login) VALUES ($1,$2,$3,$4,$5,now())
     ON CONFLICT (id) DO UPDATE SET nome=EXCLUDED.nome, email=EXCLUDED.email, role_id=EXCLUDED.role_id, unit_id=EXCLUDED.unit_id, ultimo_login=now()`,
    ["cms-" + u.id, u.name || null, u.email || null, u.role_id ?? null, u.unit_id ?? null]);
  // preenche o de-para automaticamente quando o CMS trouxer o dado (D3b)
  const un = me.unit;
  if (un && un.id != null) {
    await getPool().query(
      `INSERT INTO unidades(unit_id,nome,uf,cidade) VALUES ($1,$2,$3,$4)
       ON CONFLICT (unit_id) DO UPDATE SET nome=coalesce(unidades.nome,EXCLUDED.nome), uf=coalesce(unidades.uf,EXCLUDED.uf), cidade=coalesce(unidades.cidade,EXCLUDED.cidade)`,
      [un.id, un.name || null, un.state ? String(un.state).slice(0, 2).toUpperCase() : null, un.city || null]);
  }
}

export async function dePara(unitId) {
  if (unitId == null) return null;
  const r = await getPool().query("SELECT unit_id, nome, uf, cidade FROM unidades WHERE unit_id=$1", [unitId]);
  return r.rows[0] || null;
}

export async function listarUnidades() {
  const r = await getPool().query(
    `SELECT u.unit_id, u.nome, u.uf, u.cidade, u.atualizado_em,
            (SELECT count(*) FROM pessoas p WHERE p.unit_id=u.unit_id) AS pessoas
       FROM unidades u ORDER BY u.nome NULLS LAST, u.unit_id`);
  return r.rows;
}

export async function salvarUnidade(unitId, { nome, uf, cidade }) {
  const UF = uf ? String(uf).trim().toUpperCase() : null;
  if (UF && !/^[A-Z]{2}$/.test(UF)) throw new ErroDb("invalid_argument", "UF inválida.");
  await getPool().query(
    `INSERT INTO unidades(unit_id,nome,uf,cidade,atualizado_em) VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (unit_id) DO UPDATE SET nome=EXCLUDED.nome, uf=EXCLUDED.uf, cidade=EXCLUDED.cidade, atualizado_em=now()`,
    [Number(unitId), nome || null, UF, cidade || null]);
}

export async function perfis(ids) {
  const lista = (Array.isArray(ids) ? ids : []).filter(x => typeof x === "string").slice(0, 200);
  if (!lista.length) return {};
  const r = await getPool().query("SELECT id, nome FROM pessoas WHERE id = ANY($1)", [lista]);
  const out = {};
  r.rows.forEach(x => { out[x.id] = { id: x.id, name: x.nome || "Usuário", avatarUrl: null }; });
  return out;
}
