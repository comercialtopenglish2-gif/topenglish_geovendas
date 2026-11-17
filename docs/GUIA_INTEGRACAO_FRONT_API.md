# Guia de integração — Front × API do CMS (produção / `main`)

Como autenticar e chamar a API que está **hoje em produção** no repositório `topenglish_cms` (branch `main`), para **super admin (franqueador)**, **master (franqueado)** e **professor**.

Base de produção: `https://cms.topenglish.com.br`  
Swagger: `https://cms.topenglish.com.br/swagger`  
Código: Grape montado em `config/routes.rb` → `mount API => '/'` (`app/api/api.rb`).

> **O que este guia não cobre:** não existe namespace `/admin` nesta branch. Gestão completa de rede/unidade (alunos, royalties, contas, etc.) no HTML do CMS usa **sessão Devise + CanCan** (`Ability`), não JSON Admin.

---

## 1. Dois jeitos de entrar no sistema

| Superfície | Quem usa | Auth | Onde vive |
|------------|----------|------|-----------|
| **Portal HTML** (CMS) | Super admin, master, professor, coordenador, gráfica | Cookie / sessão **Devise** (`authenticate_user!`) | Controllers Rails + `app/models/ability.rb` |
| **API JSON** (Grape) | App, iPad, webbook, front SPA | **JWT** (ou token legado opaco, depreciado) | `app/api/topenglish/...` |

Um front novo (SPA) deve usar a **API JSON**. O login web HTML (`/users/sign_in`) não é o contrato para SPA.

---

## 2. Papéis (`users.role_id` / `roles.name`)

Tabela `roles` (seed): `super_admin`, `admin`, `teacher`.

| `role_id` | `roles.name` | Nome de negócio | Helper em `User` |
|-----------|--------------|-----------------|------------------|
| **1** | `super_admin` | Franqueador | `is_super_admin?` |
| **2** | `admin` | Master Franqueado | `is_master?` |
| **3** | `teacher` | Professor (SubFranqueado) | `is_teacher?` |
| **4** | (gráfica) | Gráfica | `is_grafica?` |

Professor com `type_teacher == true` é **coordenador** (`is_coordenador?`) — no HTML ganha permissões maiores na unidade; na API de turmas/evolução o escopo continua sendo as turmas do próprio `user_id`, salvo telas web.

**Login JSON não distingue perfil:** `User.auth` e o login v2 (`type: "teacher"`) aceitam qualquer `User` ativo. O JWT de usuário leva `typ: "teacher"` mesmo para master/super admin — significa “é registro da tabela `users`”, não “só role 3”.

O login **não devolve `role_id`**. Para montar menu/UI:

1. Decodificar o JWT (claims `user_id`, `typ`, `exp`), **ou**
2. Chamar um endpoint autenticado que exponha perfil (ex.: `GET /webbook/teacher/dashboard` → `content.role` = `my_profile_name`).

Usuário com `status = "desativado"` não autentica no Devise (`active_for_authentication?`) e a API devolve erro de desativado / credencial.

---

## 3. Famílias de API (produção)

Montagem em `app/api/api.rb`:

| Prefixo | Uso principal |
|---------|----------------|
| **`/v1/...`** | iPad / legado: autenticação de user, matrículas, evolução de turma, livros digitais, app do aluno |
| **`/v2/webbook/login`** | Login webbook (aluno **ou** user) com payload JWT assinado |
| **`/webbook/teacher/...`** | Webbook professor: dashboard, conteúdo digital, turmas, evoluções, relatório mensal |
| **`/webbook/student/...`** | Webbook aluno (fora do escopo master/professor, citado só para contraste) |

Todas respondem JSON. Muitos endpoints legados aceitam `.json` no path.

---

## 4. Login correto (User: master, super admin, professor)

Há **dois** caminhos válidos. Preferir o v2 quando o front já assina payload (webbook); o v1 é o mais simples para SPA/iPad.

### 4.1 Caminho recomendado para SPA — `GET /v1/authentication`

Código: `Topenglish::V1::Authentication` → `User.auth`.

```http
GET /v1/authentication.json?email=EMAIL&pass=SENHA
```

Sucesso (HTTP 200, corpo aproximado):

```json
{
  "token": "<JWT>",
  "token_auth": "<JWT>"
}
```

Erro (exemplos):

```json
{ "status": "ERROR", "message": "User not found." }
{ "status": "ERROR", "message": "Password is incorrect." }
{ "status": "ERROR", "message": "User desactivated." }
```

Guarde `token` (ou `token_auth` — são o mesmo JWT).  
**Atenção:** credencial na query string pode ir para log de proxy; em produção use HTTPS e evite logar a URL completa. Se puder, prefira o fluxo v2 (credencial só no payload criptografado no body).

### 4.2 Caminho webbook — `POST /v2/webbook/login`

Código: `Topenglish::V2::Login` → `LoginService.authentication`.

1. No front, monte um JWT **HS256** cujo payload é:

```json
{
  "email": "usuario@exemplo.com",
  "password": "senha",
  "type": "teacher"
}
```

(`type` deve ser `"teacher"` para qualquer User — master e super admin inclusive. `"student"` é só tabela `students`.)

2. Assine com a chave `password_secret` do CMS (`Rails.application.secrets.password_secret`). O servidor aceita a string ASCII **e** a interpretação HEX (compatibilidade com jsrsasign do webbook) — ver `TokenService.decode_payload` / `password_secret_candidates`.

3. Envie:

```http
POST /v2/webbook/login.json
Content-Type: application/json

{ "payload": "<JWT_ASSINADO_COM_password_secret>" }
```

Sucesso:

```json
{
  "status": "SUCCESS",
  "message": "...",
  "content": {
    "name": "Apelido",
    "email": "usuario@exemplo.com",
    "token": "<JWT_DE_SESSÃO>",
    "token_auth": "<JWT_DE_SESSÃO>",
    "image": { "url": "...", "thumb": "" }
  }
}
```

O JWT de sessão (`token`) é outro segredo: `jwt_secret` do CMS (`TokenService.generate_jwt_token_user`). Claims:

```json
{
  "user_id": 123,
  "typ": "teacher",
  "exp": 1710000000
}
```

Validade do token de **User**: **24 horas**.  
(Token de aluno: 30 dias — irrelevante para este guia.)

**Não coloque `password_secret` / `jwt_secret` em repositório público do front.** Use variável de ambiente do build ou um BFF que assine o payload no servidor.

### 4.3 O que não usar para User

- `POST /v1/app/auth/login` — login de **aluno** (`Student`), não de master/professor.
- Formulário Devise HTML — sessão cookie; CORS/cookie cross-site quebram SPA em outro domínio.

---

## 5. Como autenticar as chamadas seguintes

Resolução: `AuthTokenResolver` + `TokenService.decode_token`.

**Preferido (todos os clientes novos):**

```http
Authorization: Bearer <JWT>
```

**Legado (ainda aceito em várias rotas v1):**

```http
?token=<JWT>
```

ou campo `token` no body. Se vier `Authorization`, o helper injeta em `params[:token]` (`inject_token_param!`).

Regras:

1. Sempre enviar o JWT devolvido no login.
2. Em 401 / token expirado → novo login (User expira em 24h).
3. Não misturar token de aluno (`student_id`) em rota de professor: `resolve_user` só aceita JWT com `user_id`.

Namespace `/webbook/*` exige `Authorization` no `before` de `Topenglish::Webbook::Base`. Sem header válido → erro Tipenglish padrão (`status`, `message`, `type`, `code`).

---

## 6. O que cada perfil consegue na API (realidade da `main`)

A API JSON de User foi feita em torno do **professor / iPad / webbook**. Isolamento típico: `matriculations.user_id = current_user.id` e `unit_id` do próprio usuário.

| Capacidade | Super admin | Master | Professor |
|------------|-------------|--------|-----------|
| Obter JWT (`/v1/authentication` ou `/v2/webbook/login`) | Sim (User ativo) | Sim | Sim |
| `GET /v1/enrollment` — listar **próprias** turmas | Só turmas com `user_id` dele | Idem | Idem |
| `GET/POST /v1/enrollment/...` — catálogo / criar matrícula na **própria** `unit_id` | Usa `user.unit_id` | Usa unidade do master | Usa unidade do professor |
| `GET/POST/PUT/DELETE /v1/group_evolution` | Só se a turma for dele (`authorize_matriculation!`) | Idem | Idem |
| `/webbook/teacher/*` (dashboard, classes, evoluções, monthly) | Token User válido; dados = turmas dele | Idem | Caso de uso principal |
| Gestão rede / todos professores da unidade / royalties / contas | **Não via esta API** — portal HTML + CanCan | HTML (escopo unidade) | HTML (escopo menor; coordenador ampliado) |

Resumo para o front:

- **Professor:** API JSON cobre o fluxo operacional (turmas próprias, evolução, relatório mensal, livros digitais).
- **Master / super admin:** o mesmo login JWT funciona, mas **não** há endpoints de “visão de rede/unidade” como no HTML. Para gestão ampla, ou usam o CMS web, ou precisam de API nova (ainda não está na `main`).

Não invente header de unidade (`X-Active-Unit-Id` etc.): **não existe** neste código.

---

## 7. Endpoints úteis após o login (User)

Substitua `BASE` por `https://cms.topenglish.com.br`. Header em todos: `Authorization: Bearer <JWT>` (ou `token=` onde a rota ainda exige o param).

### Turmas (iPad / legado)

```http
GET BASE/v1/enrollment.json?token=<JWT>
```

Lista turmas ativas do `user_id` do token (`User.enrollment`).

```http
GET BASE/v1/enrollment/catalog.json
Authorization: Bearer <JWT>
```

Catálogo (planos da unidade, livros, templates) para abertura de turma.

```http
POST BASE/v1/enrollment.json
Authorization: Bearer <JWT>
```

Cria matrícula (ficha/contrato PDF opcionais). Ver params em `app/api/topenglish/v1/enrollment.rb`.

### Evolução de turma (v1)

```http
GET    BASE/v1/group_evolution.json?token=<JWT>&matriculation_id=ID
POST   BASE/v1/group_evolution.json
PUT    BASE/v1/group_evolution/:id.json
DELETE BASE/v1/group_evolution.json
GET    BASE/v1/group_evolution/monthly.json
PUT    BASE/v1/group_evolution/monthly.json
```

Sempre: turma deve ser do usuário (`authorize_matriculation!`). Datas de aula em horário de parede no fuso da app (`America/Maceio` no código de parse).

### Webbook professor (mais limpo para SPA moderna)

```http
GET  BASE/webbook/teacher/dashboard
GET  BASE/webbook/teacher/get_digital_content?type=books|listening|quiz
GET  BASE/webbook/teacher/classes
GET  BASE/webbook/teacher/group_evolutions?matriculation_id=&year=&month=
GET  BASE/webbook/teacher/group_evolutions/monthly/summary?matriculation_id=&year=&month=
PUT  BASE/webbook/teacher/group_evolutions/monthly/summary
POST BASE/webbook/teacher/group_evolutions
GET  BASE/webbook/teacher/group_evolutions/:id
PUT  BASE/webbook/teacher/group_evolutions/:id
DELETE BASE/webbook/teacher/group_evolutions/:id
```

Respostas no formato `{ status, message, content }`.

### Livros digitais (v1)

Namespace `/v1/digital_books/...` — token User com `type=teacher` nos params quando aplicável. Ver `DigitalBookService`.

---

## 8. Fluxo mínimo sugerido no front

```
1. Login
   GET /v1/authentication.json?email=&pass=
   → salvar token + exp (24h)

2. (Opcional) Perfil / papel
   GET /webbook/teacher/dashboard
   → content.role, agenda, totais
   OU decodificar JWT (user_id) e mapear papel via dado próprio / endpoint futuro

3. Listar turmas
   GET /webbook/teacher/classes
   (ou GET /v1/enrollment.json)

4. Evolução / relatório mensal
   rotas /webbook/teacher/group_evolutions...

5. Em 401
   limpar token → tela de login
```

Checklist:

- [ ] HTTPS só contra `cms.topenglish.com.br` (ou host de homologação alinhado ao CMS)
- [ ] Guardar JWT fora da URL após o login
- [ ] Renovar a cada 24h (ou ao receber expiração)
- [ ] UI de master/super admin: não assumir endpoints de rede que não existem na `main`
- [ ] Professor: nunca confiar só no front — o servidor só libera turma com `user_id` do token
- [ ] `password_secret` só no build privado / BFF, se usar login v2

---

## 9. Exemplos curl

### Login v1

```bash
curl -sS "https://cms.topenglish.com.br/v1/authentication.json?email=EMAIL&pass=SENHA"
```

### Dashboard professor (webbook)

```bash
TOKEN="cole_o_jwt"

curl -sS "https://cms.topenglish.com.br/webbook/teacher/dashboard" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/json"
```

### Turmas + evoluções

```bash
curl -sS "https://cms.topenglish.com.br/webbook/teacher/classes" \
  -H "Authorization: Bearer $TOKEN"

curl -sS "https://cms.topenglish.com.br/webbook/teacher/group_evolutions?matriculation_id=123" \
  -H "Authorization: Bearer $TOKEN"
```

### Login v2 (payload já assinado)

```bash
curl -sS -X POST "https://cms.topenglish.com.br/v2/webbook/login.json" \
  -H "Content-Type: application/json" \
  -d '{"payload":"eyJ..."}'
```

Para gerar o `payload` localmente (Node), assine HS256 `{ email, password, type: "teacher" }` com a mesma `password_secret` do CMS — sem commitar a chave.

---

## 10. Portal HTML (referência rápida)

Se o “front” for o próprio CMS Rails (não SPA):

1. `POST /users/sign_in` (Devise) com email/senha do `User`.
2. Sessão cookie; `before_action :authenticate_user!` em `BaseController`.
3. Autorização: `Ability` por `user.role.name` (`super_admin` → tudo; `admin` → unidade; `teacher` / coordenador → regras no arquivo).
4. Escopos web: master filtra por `unit_id`; professor por turmas próprias (com exceções de coordenador/super admin em controllers como `evolution_groups`).

Isso **não** substitui o contrato JWT acima para um front separado.

---

## 11. Armadilhas

1. **`type: "teacher"` no login v2** = User (tabela `users`), não “só role_id 3”.
2. **JWT `typ: "teacher"`** idem — não use isso sozinho para esconder telas de master.
3. **Sem `role_id` no login** — busque perfil depois ou mantenha mapeamento próprio com cuidado.
4. **Escopo = dono da turma** na API de evolução/webbook — master logado não vê turmas dos professores da unidade por essas rotas.
5. **Token legado** `users.token_auth` opaco ainda resolve em alguns caminhos; clientes novos devem usar só JWT.
6. **Aluno ≠ User** — rotas `/v1/app/...` e `/webbook/student/...` são outro mundo.
7. **Swagger** em `/swagger` documenta a API montada; confirme path real (v1 / v2 / webbook) antes de fixar o cliente.

---

## 12. Arquivos no repositório (fonte da verdade)

| Assunto | Arquivo |
|---------|---------|
| Mount da API | `app/api/api.rb`, `config/routes.rb` |
| Login v1 User | `app/api/topenglish/v1/authentication.rb`, `User.auth` |
| Login v2 | `app/api/topenglish/v2/login.rb`, `app/services/login_service.rb` |
| JWT | `app/services/token_service.rb` |
| Resolver Bearer/token | `app/services/auth_token_resolver.rb` |
| Webbook professor | `app/api/topenglish/webbook/base.rb`, `teacher_webbook.rb` |
| Matrícula API | `app/api/topenglish/v1/enrollment.rb` |
| Evolução v1 | `app/api/topenglish/v1/group_evolution.rb` |
| Evolução webbook | `app/services/group_evolution_service.rb` |
| Papéis / helpers | `app/models/role.rb`, `app/models/user.rb` |
| Permissões HTML | `app/models/ability.rb` |

Documentação interativa: `https://cms.topenglish.com.br/swagger`.
