# Integração de um front com a API do Top English CMS

Guia para qualquer app (web, mobile ou script) que precise autenticar **franqueador**, **master** e **professor** e chamar a API do `topenglish_cms`.

A API que um front novo deve usar é a namespace **Admin**, montada na raiz do Rails. O painel `admin.topenglish.com.br` já segue este contrato. As rotas antigas (`/v1/authentication` e `/v2/webbook/login`) continuam no ar para o app e o webbook; um front novo não deve começar por elas.

## Onde a API mora

| Ambiente | Base |
|---|---|
| Produção | `https://cms.topenglish.com.br` |
| Local | `http://localhost:3000` (Rails na máquina, sem Docker) |

Não há prefixo `/api`. O login é `POST https://cms.topenglish.com.br/admin/auth/login`.

Conteúdo: `Content-Type: application/json` e `Accept: application/json`.

Rotas públicas, sem token:

- `GET /admin/health` → `{ "status": "ok", "service": "topenglish-admin-api", ... }`
- `GET /admin/version`
- `GET /admin/inventory` — lista viva dos caminhos

## Os três papéis

Todos entram pelo mesmo login. O que muda é o `role_id` do usuário na tabela `users` (Devise). A API não cria sessão por cookie: devolve um JWT e o front guarda esse token.

| `role_id` | Quem é | Nome no código | O que enxerga |
|---|---|---|---|
| `1` | Franqueador (diretoria) | `super_admin` | Todas as unidades. Pode filtrar uma unidade. |
| `2` | Master franqueado | na tabela `roles` a chave se chama `admin` | Só a `unit_id` do próprio usuário. |
| `3` | Professor (subfranqueado) | `teacher` | Só as turmas em que ele é o professor, na unidade dele. |

“Admin” no banco **não** é um quarto papel. A chave `admin` do model `Role` é o **master** (`role_id` 2). Franqueador é `role_id` 1. Professor é `role_id` 3.

Outros `role_id` recebem `403` com a mensagem `Perfil sem acesso ao Admin.` Usuário com `status` igual a `desativado` (comparação sem diferenciar maiúsculas) também recebe `403`.

## Login

```http
POST /admin/auth/login
Content-Type: application/json

{ "email": "pessoa@exemplo.com", "password": "senha" }
```

O e-mail é buscado primeiro em minúsculas (com espaços nas pontas removidos) e, se não achar, de novo só com os espaços removidos. A senha é a do Devise (`valid_password?`).

Resposta `200`:

```json
{
  "token": "<jwt>",
  "token_type": "Bearer",
  "expires_in_hours": 24,
  "user": {
    "id": 10,
    "name": "Apelido",
    "email": "pessoa@exemplo.com",
    "role_id": 2,
    "role": "Master Franqueado",
    "unit_id": 4,
    "status": "ativado"
  },
  "unit": {
    "id": 4,
    "name": "Recife Sul",
    "status": null,
    "region": null,
    "city": null,
    "state": null
  }
}
```

`user.name` é o `nickname`. Se o apelido estiver vazio, a API devolve o e-mail. `unit` pode vir `null` se o usuário não tiver unidade (caso típico do franqueador).

Erros (corpo sempre `{ "error": "...", "message": "..." }`):

| HTTP | `error` | Quando |
|---|---|---|
| 401 | `unauthorized` | E-mail inexistente ou senha incorreta |
| 403 | `forbidden` | Desativado, ou papel fora de 1, 2 e 3 |

Não existe endpoint de refresh. O JWT vale **24 horas** (`exp` no payload). Quando expirar, a próxima chamada autenticada volta `401` e o app faz login de novo.

O payload assinado (HS256, segredo do servidor) carrega `user_id`, `typ: "teacher"` e `exp`. O `typ` é `teacher` para **qualquer** usuário da tabela `users`, inclusive franqueador e master. O papel de verdade é o `role_id` lido no banco a cada request, não um claim do token. Não decodifique o JWT no front para decidir permissão: chame `GET /admin/auth/me`.

## Como mandar o token

Em toda rota que não seja health, version, inventory ou o próprio login:

```http
Authorization: Bearer <jwt>
```

O header `Bearer ` (com espaço) é removido no servidor. Dá para mandar o mesmo JWT em `?token=`, mas o header é o caminho certo: token em query string vaza em log e em histórico.

`GET /admin/auth/me` confirma a sessão e devolve o que o front precisa para montar o menu:

```json
{
  "user": { "id": 10, "role_id": 2, "unit_id": 4 },
  "unit": { "id": 4, "name": "Recife Sul" },
  "capabilities": {
    "mgmt": true,
    "super_admin": false,
    "teacher_portal": false
  }
}
```

| Capability | Verdadeiro quando |
|---|---|
| `super_admin` | `role_id == 1` (franqueador) |
| `mgmt` | `role_id` 1 ou 2 (franqueador ou master) |
| `teacher_portal` | `role_id == 3` (professor) |

Token inválido, assinatura ruim ou expirado: `401` com `Token inválido ou expirado.`

## Unidade ativa

Franqueador escolhe a unidade. Master e professor ficam presos na deles.

Mande os dois, com o mesmo id (é o que o Admin React faz):

```http
X-Active-Unit-Id: 4
```

e, quando a rota aceitar, `?unit_id=4`. A API lê primeiro `unit_id` da query e depois o header.

| Papel | Efeito |
|---|---|
| Franqueador sem filtro | Vê a rede inteira (`scoped_unit_ids` nulo). |
| Franqueador com id | Listas e KPIs daquela unidade. |
| Master ou professor | Ignora um filtro igual à unidade dele. Se o id for **outro**, responde `403` `Unidade fora do seu escopo.` |

Não use o header para “abrir” outra unidade no master ou no professor. O servidor recusa.

## O que cada papel pode chamar

Toda rota abaixo exige o Bearer, salvo as três públicas. Professor numa rota de gestão recebe `403` `Somente gestão (franqueador/master).` Master numa rota de franqueador recebe `403` `Somente franqueador.`

### Franqueador e master (`mgmt`)

Leitura de gestão: `GET /admin/dashboard`, `/admin/search?q=`, `/admin/units`, `/admin/teachers`, `/admin/teachers/:id`, `/admin/presence/summary`, `/admin/presence/turma`, `/admin/finance/summary`, `/admin/finance/by_unit`, `/admin/finance/royalties`, `/admin/retention/summary`, `/admin/retention/ltv_churn`, `/admin/retention/cancellations`, `/admin/hour_bank/summary`, `/admin/hour_bank/recent`, `/admin/repositions/summary`, `/admin/repositions/recent`, `/admin/sync/...`.

Escrita de gestão: `POST /admin/turmas/:id/transfer` com `{ "to_user_id", "reason" }`.

O master só recebe dados da própria `unit_id`. Lista de professores e de unidades já sai filtrada.

### Só franqueador

- `GET /admin/finance/bill_pays`
- `GET /admin/finance/advertising_taxes`
- `GET /admin/parity`

### Professor, master e franqueador

Turmas, alunos, livros e evolução, já cortados pelo escopo:

- `GET /admin/turmas` e `GET /admin/turmas/:id`
- `GET /admin/students` e `GET /admin/students/:id`
- `GET /admin/books`
- `GET /admin/evolutions`, `/admin/evolutions/timeline`, `/admin/evolutions/hour_bank`, `/admin/evolutions/monthly_reports`, `/admin/evolutions/student`
- `GET /admin/hour_bank?matriculation_id=`
- `GET /admin/repositions?matriculation_id=`
- `POST /admin/evolutions`
- `PUT /admin/turmas/:id/schedule`

No professor, turma e aluno ficam restritos às matrículas em que `user_id` é o id dele **e** `unit_id` é a unidade dele. Abrir turma de outro professor na mesma unidade responde `403`. Franqueador acessa qualquer turma; master, qualquer turma da unidade.

No CMS, **turma = matrícula** (`matriculations.id` é o número da turma). Aula lançada é `evolution_groups`.

Listas paginadas devolvem:

```json
{
  "data": [],
  "meta": { "page": 1, "per_page": 25, "total": 0, "total_pages": 0 }
}
```

`page` mínimo 1. `per_page` máximo 100. Sem `per_page`, vale 25. Em turmas, `status` padrão é `Ativo`; mande `status=all` para não filtrar.

### Só professor

- `GET /admin/teacher_portal/dashboard`
- `GET /admin/teacher_portal/week?offset=0`

Franqueador e master recebem `403` `Portal só para professor.` O app do professor usa estas duas rotas para a home. Gestão usa `/admin/dashboard`.

## Fluxo recomendado no front

1. Tela de login chama `POST /admin/auth/login`.
2. Guarda `token` (memória segura ou storage do app). Não guarde a senha.
3. Se `user.role_id` não for `1`, fixe a unidade ativa em `user.unit_id` (header + query). Se for `1`, comece sem unidade (rede inteira) e só grave `X-Active-Unit-Id` quando a pessoa escolher uma unidade no seletor.
4. Chame `GET /admin/auth/me` para preencher `capabilities` e decidir a home:
   - `teacher_portal` → portal do professor
   - `mgmt` → dashboard de gestão
5. Em toda chamada, mande `Authorization: Bearer <token>`.
6. Em `401`, apague o token e volte ao login.
7. Em `403`, mostre a mensagem do corpo. Não tente de novo com outro header de unidade: o escopo é do usuário, não da tela.

Exemplo mínimo:

```bash
BASE=https://cms.topenglish.com.br

TOKEN=$(curl -s -X POST "$BASE/admin/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"pessoa@exemplo.com","password":"senha"}' \
  | jq -r .token)

curl -s "$BASE/admin/auth/me" \
  -H "Authorization: Bearer $TOKEN"

curl -s "$BASE/admin/turmas?page=1&per_page=25" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Active-Unit-Id: 4"
```

## CORS (só browser)

`/admin/*` aceita origem explícita, com credencial:

- `https://admin.topenglish.com.br`
- `http://localhost:5173` e `http://127.0.0.1:5173`
- `http://localhost:4173` e `http://127.0.0.1:4173`

A lista está em dois lugares e os dois precisam do domínio novo: `config/application.rb` (Rack::Cors) e `allowed_origin` em `app/api/topenglish/admin/v1/base.rb`. Origem fora da lista recebe o header de CORS apontando para `https://admin.topenglish.com.br`, e o browser bloqueia a resposta.

App nativo, servidor e `curl` não passam por CORS. Eles só precisam da base e do Bearer.

Headers liberados: `Origin`, `Content-Type`, `Accept`, `Authorization`, `X-Active-Unit-Id`.

O Admin React, em desenvolvimento, deixa `VITE_API_BASE_URL` vazio e o Vite faz proxy de `/admin` para o Rails. Em produção a variável é `https://cms.topenglish.com.br`. Um front em outro host deve apontar a base direto para o CMS e entrar na lista de origens.

## O que não usar num front novo

Estas rotas continuam para o app antigo e o webbook. O JWT emitido em `/admin/auth/login` é o mesmo `TokenService` (`user_id` + `typ: teacher`), então o token do Admin também abre parte da API legada de professor. Mesmo assim, o contrato estável para franqueador, master e professor é `/admin`.

| Rota legada | Por que evitar |
|---|---|
| `GET /v1/authentication?email=&pass=` | Senha na query string. Não devolve papel nem unidade. Não recusa papel fora do Admin. |
| `POST /v2/webbook/login` | Corpo é um JWT cifrado com outro segredo (`email`, `password`, `type` = `student` ou `teacher`). Feito para o webbook, não para um painel. |

Aluno é outro ator (`Student`, token com `student_id`). Este guia não cobre login de aluno.

## Referência no código

- Login e `/me`: `app/api/topenglish/admin/v1/auth.rb`
- Papéis, Bearer e unidade: `app/api/topenglish/admin/v1/helpers.rb`
- JWT: `app/services/token_service.rb` (`generate_jwt_token_user` / `decode_token`)
- Formato de `user` e `unit`: `app/services/admin_api/serializers.rb`
- Lista de rotas: `GET /admin/inventory` e `docs/ADMIN_API_INVENTORY.md`
- Cliente de referência: `topenglish_admin_front/src/auth/AuthContext.tsx` e `src/lib/api.ts`
