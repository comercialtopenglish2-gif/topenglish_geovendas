// ÚNICO lugar com o mapa role_id do Top English CMS -> permissões do GeoVenda.
// Papel ausente neste mapa = bloqueado (falha fechada).
// Decisão D2 (17/11/2026): franqueador vê tudo; master só a unidade dele; professor bloqueado.

export const PAPEIS = {
  1: { papel: "master",  rotulo: "Franqueador", todosEstados: true,  todasUnidades: true,  editaBase: true  },
  2: { papel: "unidade", rotulo: "Master",      todosEstados: false, todasUnidades: false, editaBase: false },
  // 3 (professor): ausente = bloqueado, até decisão em contrário.
};

export const MSG_SEM_ACESSO = "Perfil sem acesso ao GeoVenda.";
export const MSG_SEM_UF = "Sua unidade ainda não tem estado configurado. Fale com o franqueador.";

export function papelDe(roleId) {
  return Object.prototype.hasOwnProperty.call(PAPEIS, roleId) ? PAPEIS[roleId] : null;
}

// Monta a identidade do GeoVenda a partir do /me do CMS e do de-para de unidades (D3b).
// `dePara` = linha da tabela `unidades` ({ unit_id, nome, uf, cidade }) ou null.
export function identidade(me, dePara) {
  const user = (me && me.user) || {};
  const p = papelDe(Number(user.role_id));
  if (!p) return { ok: false, motivo: MSG_SEM_ACESSO };
  const unit = (me && me.unit) || null;
  const uf = (dePara && dePara.uf) || (unit && unit.state) || null;
  const cidade = (dePara && dePara.cidade) || (unit && unit.city) || null;
  const nomeUnidade = (dePara && dePara.nome) || (unit && unit.name) || null;
  const pendente = !p.todosEstados && !uf; // master sem UF resolvida: não libera dados
  return {
    ok: true,
    pessoaId: "cms-" + user.id,
    roleId: Number(user.role_id),
    papel: p.papel,
    rotulo: p.rotulo,
    master: p.papel === "master",
    editaBase: p.editaBase,
    todasUnidades: p.todasUnidades,
    unitId: user.unit_id == null ? null : Number(user.unit_id),
    // espaço do GeoFunil: por unidade do CMS (D2/D3). Franqueador sem unidade usa o próprio espaço.
    espaco: user.unit_id != null ? "unit-" + user.unit_id : "cms-" + user.id,
    unidade: nomeUnidade,
    uf: p.todosEstados ? (uf || null) : uf,
    cidade,
    pendente,
    motivoPendente: pendente ? MSG_SEM_UF : null,
  };
}
