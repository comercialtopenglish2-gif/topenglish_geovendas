# GeoVenda

**Processos Comerciais e Inteligência de praça para vender mais!** · by CNC Training & Consulting

Sistema de vendas dos masters da rede Top English. O front-end (`public/index.html`) é HTML e JavaScript puro, sem build. Ele é servido por um **servidor intermediário em Node** que exige login no **Top English CMS** antes de entregar qualquer arquivo.

## Como funciona

```
navegador ──► servidor GeoVenda (Railway) ──► Top English CMS  (login e /me)
                  │                       └─► API da Anthropic (IA)
                  └─► PostgreSQL (Railway)  (leads, funil, treinos…)
```

- **Público** (só isto): `/healthz`, `/login`, `/login/*`, `POST /auth/login` e `POST /auth/logout`.
- **Todo o resto exige sessão.** Sem sessão:
  - páginas redirecionam para `/login`;
  - arquivos e API respondem `401`.
- **Login** (API que está em produção no CMS, `docs/GUIA_INTEGRACAO_FRONT_API.md`), sempre feito pelo servidor, nunca pelo navegador:
  - com `CMS_PASSWORD_SECRET`: login v2 `POST /v2/webbook/login`, com o payload `{email, password, type:"teacher"}` assinado (HS256) no servidor;
  - sem essa chave: login v1 `GET /v1/authentication`, em HTTPS. A URL nunca vai para log.
- **Sessão:**
  - o navegador recebe só um id aleatório no cookie `gv_session` (`HttpOnly`, `Secure` em produção, `SameSite=Lax`, até 24 h);
  - o token do CMS fica no banco (tabela `sessoes`); o JavaScript da página nunca o vê;
  - o token é conferido no CMS em `GET /webbook/teacher/dashboard`, com cache de 60 s;
  - se o CMS estiver fora do ar e o cache vencido, a resposta é `503`: o acesso nunca é liberado por padrão.
- **`public/claude-shim.js`** recria o `window.claude.use(...)` que o app usava dentro do Claude:
  - `user`: `id`, `isOwner`, `can`, `canEdit`, `profiles`;
  - `db`: estilo Firestore sobre `/api/db`, com `onSnapshot` por polling de 4 s;
  - `sample`: IA com streaming, conversa, imagens, `json` e `limits`;
  - `downloads`.

  Ele também limpa o cache local quando outra pessoa entra no mesmo navegador e mostra quem está logado, com o botão **Sair**.
- A identidade chega ao front por `window.GV_SESSION`, que o servidor injeta no `index.html` a cada requisição. A mesma informação está em `GET /api/session`.

## Papéis (decisão D2) · `server/roles.js` e `/acessos`

A API de produção do CMS confirma e-mail e senha, mas **não informa papel nem unidade**. Por isso o GeoVenda guarda quem pode entrar:

| Papel no GeoVenda | Como se define | Acesso |
|---|---|---|
| Franqueador | e-mail em `GV_FRANQUEADORES` (Railway) ou liberado como franqueador em `/acessos` | todos os estados e unidades; edita os textos-base (Método, Top English); libera acessos e cria unidades em `/acessos` |
| Master | liberado em `/acessos`, sempre com uma unidade (nome, UF, cidade) | só a UF da unidade (arquivos `data/` e `bairros/` de outras UFs dão `403`) e só o funil da unidade |
| Qualquer outro (inclusive professores) | não está em `/acessos` | bloqueado: "Seu acesso ao GeoVenda ainda não foi liberado." |

- Quem tenta entrar sem acesso aparece em **Pessoas aguardando liberação**, em `/acessos`, com o perfil que o CMS informa. Basta clicar em **Liberar**.
- Desativar ou remover um acesso derruba a sessão da pessoa na hora.
- Usuário desativado no CMS não consegue mais entrar; a sessão aberta dura no máximo 24 h.

## Regras de dados · `server/db.js`

| Caminho | Regra |
|---|---|
| `data/users/<pessoa>/…` | só a própria pessoa |
| `equipe/<pessoa>` | a pessoa escreve o seu; só o franqueador lista a equipe |
| `escolas/<espaço>/…` (GeoFunil) | espaço `unit-<unit_id>` da unidade; franqueador acessa todos |
| `vendedor/*`, `config/*`, `fontes/*` | todos leem; só o franqueador escreve |
| `pedidos`, `relatorios`, `monitor`, `horarios`, `proprios`, `dicas`, `palavras` | compartilhados entre todos os logados (como no Claude) |
| qualquer outro caminho | bloqueado |

- **Limites:** 900 KB por documento e 60 MB por pessoa. Acima disso, a resposta tem o código `quota_exceeded`.

## IA (decisão D5a) · `server/ai.js`

- **Chave:** a chave da Anthropic fica só no Railway (`ANTHROPIC_API_KEY`). Sem a chave, a IA fica desligada e as telas mostram "IA indisponível".
- **Limite:** `AI_DAILY_CALLS` chamadas por pessoa por dia (padrão 150). O uso fica registrado na tabela `uso_ia`.
- **Modelos:** variam por nível (`quick`, `default`, `complex`) e podem ser trocados em `AI_MODEL_QUICK`, `AI_MODEL_DEFAULT` e `AI_MODEL_COMPLEX`. **Confira os nomes atuais em https://docs.claude.com antes do deploy.**

## Rodar localmente (sem senhas reais)

Requisitos: Node 20+ e PostgreSQL.

```bash
npm ci
createdb geovenda
npm run mock-cms                     # CMS falso em :4000 (usuários de teste, senha teste123)
DATABASE_URL=postgres://localhost/geovenda CMS_BASE_URL=http://localhost:4000 npm run dev
# abra http://localhost:8080 e entre com franqueador@teste.com / teste123
npm test                             # matriz de testes de acesso (com o servidor e o CMS falso no ar)
```

Usuários do CMS falso (formato da API de produção): `franqueador@teste.com`, `master.rj@teste.com`, `master.novo@teste.com`, `professor@teste.com` e `desativado@teste.com`. Rode o servidor com `GV_FRANQUEADORES=franqueador@teste.com`. Para testar o login v2, use `CMS_PASSWORD_SECRET=segredo-de-teste`.

Para testar a IA sem custo, rode `node server/dev/mock-anthropic.js` e use `ANTHROPIC_API_KEY=teste ANTHROPIC_API_URL=http://localhost:4100`.

## Variáveis de ambiente

Veja `.env.example`.

| Variável | Uso |
|---|---|
| `DATABASE_URL` | obrigatória |
| `CMS_BASE_URL` | padrão `https://cms.topenglish.com.br` |
| `GV_FRANQUEADORES` | e-mails de franqueador, separados por vírgula |
| `CMS_PASSWORD_SECRET` | opcional: ativa o login v2 (senha só no corpo da requisição) |
| `NODE_ENV` | `production` no Railway |
| `PORT` | o Railway injeta |
| `ANTHROPIC_API_KEY` | opcional: sem ela, a IA fica desligada |

## Publicação

Deploy automático no Railway a cada push na branch `main`. O healthcheck é `/healthz`, e o banco é criado e atualizado sozinho ao iniciar (`server/migrations`). O passo a passo está em `PASSO-A-PASSO.md`.

## Limitações conhecidas

- **Sem refresh de sessão:** o token do CMS vale 24 h; depois disso, a pessoa faz login de novo.
- **Nomes no painel da equipe:** só aparecem pessoas que já entraram ao menos uma vez.
- **Fila de pedidos de relatório (Radar › Pedidos):** no Claude, uma rotina externa transformava pedidos em relatórios. Fora do Claude, os pedidos ficam na fila até essa rotina ser recriada no servidor.
- **Usuário desativado no CMS:** confirmar com o time do CMS se `/webbook/teacher/dashboard` recusa tokens de desativados. Se não recusar, a pessoa mantém a sessão aberta até 24 h (ou até o franqueador desativá-la em `/acessos`).
- **API `/admin`:** quando o CMS publicar o namespace `/admin` (`docs/INTEGRACAO_API_FRONT.md`), o papel e a unidade poderão vir do CMS em vez da tabela `acessos`.
- **CSP:** ainda não foi aplicada, porque o `index.html` usa scripts inline.
- **Bibliotecas por CDN:** jsPDF, SheetJS, ExcelJS, pdf.js e mammoth ainda vêm de CDN, com versão fixa.
