// ÚNICO lugar com o mapa de papéis do GeoVenda.
// Modo "admin" (padrão): o papel vem do role_id que o CMS devolve em /admin/auth/me (docs/INTEGRACAO_API_FRONT.md).
// Modo "legado": a API antiga não informa role_id nem unidade; o papel vem da tabela `acessos`, mantida em /acessos.
// Papel desconhecido ou ausente (inclusive professores) fica bloqueado: falha fechada.
// Decisão D2 (17/11/2026): franqueador vê tudo; master só a unidade dele; professor bloqueado.

export const PAPEIS = {
  franqueador: { papel: "master",  rotulo: "Franqueador", todosEstados: true,  editaBase: true  },
  master:      { papel: "unidade", rotulo: "Master",      todosEstados: false, editaBase: false },
};

export const MSG_SEM_ACESSO = "Seu acesso ao GeoVenda ainda não foi liberado. Fale com o franqueador.";
export const MSG_CODIGO_REDE = "Digite o código da franqueadora para ver o resultado de todas as unidades.";
export const MSG_SEM_UF = "Sua unidade ainda não tem estado configurado. Fale com o franqueador.";

// e-mails de franqueador definidos no Railway (GV_FRANQUEADORES) entram sempre como franqueador
export function franqueadoresFixos() {
  return String(process.env.GV_FRANQUEADORES || "").split(/[,;\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
}

// acesso = linha de `acessos` + unidade ({ papel, unit_id, ativo, unidade_nome, uf, cidade }) ou null
export function identidade(sessao, acesso, nome) {
  const email = String(sessao.email || "").toLowerCase();
  let papelKey = acesso && acesso.ativo ? acesso.papel : null;
  if (franqueadoresFixos().includes(email)) papelKey = "franqueador";
  const p = papelKey ? PAPEIS[papelKey] : null;
  if (!p) return { ok: false, motivo: MSG_SEM_ACESSO };
  const unitId = p.todosEstados ? null : (acesso && acesso.unit_id != null ? Number(acesso.unit_id) : null);
  const uf = acesso && acesso.uf ? String(acesso.uf) : null;
  const pendente = !p.todosEstados && (!unitId || !uf); // master sem unidade ou sem UF: não libera dados
  return {
    ok: true,
    pessoaId: sessao.pessoaId,
    email,
    nome: nome || null,
    papel: p.papel,
    rotulo: p.rotulo,
    master: p.papel === "master",
    editaBase: p.editaBase,
    unitId,
    espaco: unitId ? "unit-" + unitId : sessao.pessoaId,
    unidade: unitId && acesso ? acesso.unidade_nome || null : null,
    uf: p.todosEstados ? null : uf,
    cidade: unitId && acesso ? acesso.cidade || null : null,
    pendente,
    motivoPendente: pendente ? MSG_SEM_UF : null,
  };
}

// ---------- modo "admin": papel e unidade vêm do CMS ----------
// role_id do CMS -> papel do GeoVenda. Ausente = bloqueado (3 = professor, 4 = gráfica, outros).
export const PAPEIS_CMS = { 1: "franqueador", 2: "master" };
export const MSG_PERFIL_BLOQUEADO = "Perfil sem acesso ao GeoVenda.";

const UFS = { "acre": "AC", "alagoas": "AL", "amapa": "AP", "amazonas": "AM", "bahia": "BA", "ceara": "CE", "distrito federal": "DF",
  "espirito santo": "ES", "goias": "GO", "maranhao": "MA", "mato grosso": "MT", "mato grosso do sul": "MS", "minas gerais": "MG",
  "para": "PA", "paraiba": "PB", "parana": "PR", "pernambuco": "PE", "piaui": "PI", "rio de janeiro": "RJ", "rio grande do norte": "RN",
  "rio grande do sul": "RS", "rondonia": "RO", "roraima": "RR", "santa catarina": "SC", "sao paulo": "SP", "sergipe": "SE", "tocantins": "TO" };
const SIGLAS = new Set(Object.values(UFS));
// "Alagoas", "AL", "al" -> "AL"; desconhecido -> null
export function ufDe(estado) {
  if (!estado) return null;
  const t = String(estado).normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  if (t.length === 2 && SIGLAS.has(t.toUpperCase())) return t.toUpperCase();
  return UFS[t] || null;
}

// me = resposta de /admin/auth/me; dePara = linha da tabela `unidades` (correção feita pelo franqueador) ou null
export function identidadeAdmin(me, dePara) {
  const u = (me && me.user) || {};
  const papelKey = PAPEIS_CMS[Number(u.role_id)];
  if (!papelKey || String(u.status || "").toLowerCase() === "desativado") return { ok: false, motivo: MSG_PERFIL_BLOQUEADO };
  const p = PAPEIS[papelKey];
  const unit = (me && me.unit) || {};
  const unitId = u.unit_id != null ? Number(u.unit_id) : (unit.id != null ? Number(unit.id) : null);
  const uf = (dePara && dePara.uf) || ufDe(unit.state);
  const pendente = !p.todosEstados && (!unitId || !uf);
  return {
    ok: true,
    pessoaId: "cms-" + u.id,
    email: String(u.email || "").toLowerCase(),
    nome: u.name || u.nickname || null,
    papel: p.papel, rotulo: p.rotulo, master: p.papel === "master", editaBase: p.editaBase,
    unitId: p.todosEstados ? null : unitId,
    // master: espaço do funil = unidade do CMS; franqueador: espaço próprio (vê todas as unidades pela lista de escolas)
    espaco: p.todosEstados ? "cms-" + u.id : "unit-" + unitId,
    unidade: p.todosEstados ? null : ((dePara && dePara.nome) || unit.name || null),
    uf: p.todosEstados ? null : uf,
    cidade: p.todosEstados ? null : ((dePara && dePara.cidade) || unit.city || null),
    pendente,
    motivoPendente: pendente ? MSG_SEM_UF : null,
  };
}
