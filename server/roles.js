// ÚNICO lugar com o mapa de papéis do GeoVenda.
// A API de produção do CMS não informa role_id nem unidade (docs/GUIA_INTEGRACAO_FRONT_API.md, seção 2).
// Por isso o papel vem da tabela `acessos` do GeoVenda, mantida pelo franqueador em /acessos.
// Quem não está em `acessos` (inclusive professores) fica bloqueado: falha fechada.
// Decisão D2 (17/11/2026): franqueador vê tudo; master só a unidade dele; professor bloqueado.

export const PAPEIS = {
  franqueador: { papel: "master",  rotulo: "Franqueador", todosEstados: true,  editaBase: true  },
  master:      { papel: "unidade", rotulo: "Master",      todosEstados: false, editaBase: false },
};

export const MSG_SEM_ACESSO = "Seu acesso ao GeoVenda ainda não foi liberado. Fale com o franqueador.";
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
