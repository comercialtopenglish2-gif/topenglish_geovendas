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
- **Sessão:**
  - o token do CMS fica no cookie `gv_session` (`HttpOnly`, `Secure` em produção, `SameSite=Lax`, 24 h);
  - o JavaScript da página nunca vê o token;
  - cada requisição é validada em `GET /admin/auth/me` do CMS, com cache de 60 s;
  - se o CMS estiver fora do ar e o cache vencido, a resposta é `503`: o acesso nunca é liberado por padrão.
- **`public/claude-shim.js`** recria o `window.claude.use(...)` que o app usava dentro do Claude:
  - `user`: `id`, `isOwner`, `can`, `canEdit`, `profiles`;
  - `db`: estilo Firestore sobre `/api/db`, com `onSnapshot` por polling de 4 s;
  - `sample`: IA com streaming, conversa, imagens, `json` e `limits`;
  - `downloads`.

  Ele também limpa o cache local quando outra pessoa entra no mesmo navegador e mostra quem está logado, com o botão **Sair**.
- A identidade chega ao front por `window.GV_SESSION`, que o servidor injeta no `index.html` a cada requisição. A mesma informação está em `GET /api/session`.

## Papéis (decisão D2) · `server/roles.js`

| CMS `role_id` | No GeoVenda | Acesso |
|---|---|---|
| 1 · Franqueador | `master` | todos os estados, todas as unidades, edita os textos-base (Método, Top English), configura unidades em `/unidades` |
| 2 · Master franqueado | `unidade` | só a UF da unidade (arquivos `data/` e `bairros/` de outras UFs dão `403`) e só o espaço do funil da unidade dele |
| 3 · Professor | bloqueado | "Perfil sem acesso ao GeoVenda." |
| outros, ou desativado | bloqueado pelo CMS | |

- **Unidade sem UF:** o master vê "Sua unidade ainda não tem estado configurado" e não recebe dados até o franqueador preencher a UF em **`/unidades`** (de-para D3b).
- **Preenchimento automático:** se o CMS mandar `unit.state`, o de-para é preenchido sozinho.

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

Usuários do CMS falso:
- `franqueador@teste.com` (role 1);
- `master.rj@teste.com` (role 2, unidade com UF RJ);
- `master@teste.com` (role 2, unidade sem UF);
- `professor@teste.com` (role 3);
- `desativado@teste.com`.

Para testar a IA sem custo, rode `node server/dev/mock-anthropic.js` e use `ANTHROPIC_API_KEY=teste ANTHROPIC_API_URL=http://localhost:4100`.

## Variáveis de ambiente

Veja `.env.example`.

| Variável | Uso |
|---|---|
| `DATABASE_URL` | obrigatória |
| `CMS_BASE_URL` | padrão `https://cms.topenglish.com.br` |
| `NODE_ENV` | `production` no Railway |
| `PORT` | o Railway injeta |
| `ANTHROPIC_API_KEY` | opcional: sem ela, a IA fica desligada |

## Publicação

Deploy automático no Railway a cada push na branch `main`. O healthcheck é `/healthz`, e o banco é criado e atualizado sozinho ao iniciar (`server/migrations`). O passo a passo está em `PASSO-A-PASSO.md`.

## Limitações conhecidas

- **Sem refresh de sessão:** o token do CMS vale 24 h; depois disso, a pessoa faz login de novo.
- **Nomes no painel da equipe:** só aparecem pessoas que já entraram ao menos uma vez.
- **Fila de pedidos de relatório (Radar › Pedidos):** no Claude, uma rotina externa transformava pedidos em relatórios. Fora do Claude, os pedidos ficam na fila até essa rotina ser recriada no servidor.
- **Usuário desativado:** confirmar com o time do CMS que `/admin/auth/me` recusa desativados. Se não recusar, a pessoa mantém o acesso até o token expirar (até 24 h).
- **CSP:** ainda não foi aplicada, porque o `index.html` usa scripts inline.
- **Bibliotecas por CDN:** jsPDF, SheetJS, ExcelJS, pdf.js e mammoth ainda vêm de CDN, com versão fixa.
