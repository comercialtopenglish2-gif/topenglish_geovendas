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
- **Login no Top English CMS**, sempre feito pelo servidor, nunca pelo navegador. A variável `CMS_API` escolhe a API:
  - `admin` (padrão): `POST /admin/auth/login` e `GET /admin/auth/me` (`docs/INTEGRACAO_API_FRONT.md`). Papel e unidade vêm do CMS. Hoje em `https://cmsdev.topenglish.com.br`.
  - `legado`: API antiga de `cms.topenglish.com.br` (`docs/GUIA_INTEGRACAO_FRONT_API.md`), com login v2 (`CMS_PASSWORD_SECRET`) ou v1, e papel pela tabela `acessos`.
- **Sessão:**
  - o navegador recebe só um id aleatório no cookie `gv_session` (`HttpOnly`, `Secure` em produção, `SameSite=Lax`, até 24 h);
  - o token do CMS fica no banco (tabela `sessoes`); o JavaScript da página nunca o vê;
  - o token é conferido no CMS a cada 60 s (`/admin/auth/me` no modo `admin`; `/webbook/teacher/dashboard` no `legado`);
  - se o CMS estiver fora do ar e o cache vencido, a resposta é `503`: o acesso nunca é liberado por padrão.
- **`public/claude-shim.js`** recria o `window.claude.use(...)` que o app usava dentro do Claude:
  - `user`: `id`, `isOwner`, `can`, `canEdit`, `profiles`;
  - `db`: estilo Firestore sobre `/api/db`, com `onSnapshot` por polling de 4 s;
  - `sample`: IA com streaming, conversa, imagens, `json` e `limits`;
  - `downloads`.

  Ele também limpa o cache local quando outra pessoa entra no mesmo navegador e mostra quem está logado, com o botão **Sair**.
- A identidade chega ao front por `window.GV_SESSION`, que o servidor injeta no `index.html` a cada requisição. A mesma informação está em `GET /api/session`.

## Papéis (decisão D2) · `server/roles.js`

**Modo `admin` (padrão):** o papel vem do `role_id` do CMS.

| CMS `role_id` | No GeoVenda | Acesso |
|---|---|---|
| 1 · Franqueador (super_admin) | `master` | todos os estados e unidades; edita os textos-base; corrige UF/cidade das unidades em `/acessos` |
| 2 · Master franqueado (admin) | `unidade` | só a UF da unidade do CMS (outras UFs dão `403`) e só o funil da unidade (`unit-<unit_id>`) |
| 3 · Professor, 4 · Gráfica, outros | bloqueado | "Perfil sem acesso ao GeoVenda." |

- O CMS manda o estado por extenso ("Alagoas"); o GeoVenda converte para a sigla (AL). Se a unidade vier sem estado, o master vê "Sua unidade ainda não tem estado configurado" até o franqueador preencher a UF em `/acessos`. A correção do franqueador vale sobre o que o CMS mandar.

**Modo `legado`:** a API antiga não informa papel nem unidade. Os franqueadores vêm de `GV_FRANQUEADORES`; os masters são liberados em `/acessos` (com unidade, UF e cidade); quem não está na lista, inclusive professores, fica bloqueado.

## Regras de dados · `server/db.js`

| Caminho | Regra |
|---|---|
| `data/users/<pessoa>/…` | só a própria pessoa |
| `equipe/<pessoa>` | a pessoa escreve o seu; só o franqueador lista a equipe |
| `escolas/<espaço>/…` (GeoFunil) | espaço `unit-<unit_id>` da unidade; franqueador acessa todos |
| `vendedor/*`, `config/*`, `fontes/*` | todos leem; só o franqueador escreve |
| `campanhas` (Campanhas e brindes) | todos leem; só o franqueador cria e edita |
| `unidades`, `participacoes`, `estoque` (Campanhas e brindes) | franqueador escolhe entrar como Unidade (só a unidade da conta dele) ou como Franqueadora (tudo, depois de digitar o código `CAMP_CODIGO_REDE`; vale até sair do sistema ou trocar); o master só vê o que é da unidade dele (`u<unit_id>`), lança e edita alunos dela e não mexe no estoque |
| `pedidos`, `relatorios`, `monitor`, `horarios`, `proprios`, `dicas`, `palavras` | compartilhados entre todos os logados (como no Claude) |
| qualquer outro caminho | bloqueado |

- **Limites:** 900 KB por documento e 60 MB por pessoa. Acima disso, a resposta tem o código `quota_exceeded`.

## IA (decisão D5a) · `server/ai.js`

- **Chave:** a chave da Anthropic fica só no Railway (`ANTHROPIC_API_KEY`). Sem a chave, a IA fica desligada e as telas mostram "IA indisponível".
- **Limite:** `AI_DAILY_CALLS` chamadas por pessoa por dia (padrão 150). O uso fica registrado na tabela `uso_ia`.
- **Limite mensal em dólar:** cada pessoa (master ou franqueador) tem `AI_MONTHLY_USD` por mês (padrão US$ 10). O ciclo renova todo dia 5, à meia-noite de Brasília, e não acumula. Ao chegar no limite, `/api/ai/sample` responde `budget_exhausted` até o próximo dia 5. O custo de cada chamada (tokens × preço do modelo) fica na tabela `uso_ia_eventos`, com a função (tela) de onde veio. Preços padrão em `server/ai.js`; para trocar, use `AI_PRECOS` (JSON). A barra fica no quadro do usuário no menu e o detalhe em Conta › Uso de IA (`GET /api/ai/uso`).
- **Modelos de reserva:** `AI_MODEL_FALLBACK` (lista separada por vírgula) é usada se o modelo configurado não existir. `GET /api/ai/diagnostico` (só franqueador) testa a IA e mostra o motivo de falha.
- **Modelos:** variam por nível (`quick`, `default`, `complex`) e podem ser trocados em `AI_MODEL_QUICK`, `AI_MODEL_DEFAULT` e `AI_MODEL_COMPLEX`. **Confira os nomes atuais em https://docs.claude.com antes do deploy.**

## Rodar localmente (sem senhas reais)

Requisitos: Node 20+ e PostgreSQL.

```bash
npm ci
createdb geovenda
npm run mock-cms                     # CMS falso em :4000 (usuários de teste, senha teste123)
DATABASE_URL=postgres://localhost/geovenda CMS_BASE_URL=http://localhost:4000 npm run dev
# abra http://localhost:8080 e entre com franqueador@teste.com / teste123
npm test                             # matriz de testes de acesso, modo admin (banco limpo, servidor e CMS falso no ar)
# modo legado: rode o servidor com CMS_API=legado GV_FRANQUEADORES=franqueador@teste.com e use npm run test:legado
```

Usuários do CMS falso (atende os dois formatos de API): `franqueador@teste.com`, `master.rj@teste.com` (unidade no RJ), `master.novo@teste.com` (unidade sem estado), `professor@teste.com` e `desativado@teste.com`. No modo legado, rode o servidor com `GV_FRANQUEADORES=franqueador@teste.com`; para testar o login v2, use `CMS_PASSWORD_SECRET=segredo-de-teste`.

Para testar a IA sem custo, rode `node server/dev/mock-anthropic.js` e use `ANTHROPIC_API_KEY=teste ANTHROPIC_API_URL=http://localhost:4100`.

## Variáveis de ambiente

Veja `.env.example`.

| Variável | Uso |
|---|---|
| `DATABASE_URL` | obrigatória |
| `CMS_BASE_URL` | padrão `https://cms.topenglish.com.br` |
| `CMS_API` | `admin` (padrão) ou `legado` |
| `CAMP_CODIGO_REDE` | código da franqueadora para ver todas as unidades em Campanhas e brindes; sem ela, ninguém vê a rede toda |
| `GV_FRANQUEADORES` | só no modo legado: e-mails de franqueador, separados por vírgula |
| `CMS_PASSWORD_SECRET` | só no modo legado, opcional: ativa o login v2 |
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
- **Ambiente do CMS:** a API `/admin` está em `cmsdev.topenglish.com.br`. Quando for publicada em `cms.topenglish.com.br`, basta trocar `CMS_BASE_URL` no Railway.
- **CSP:** ainda não foi aplicada, porque o `index.html` usa scripts inline.
- **Bibliotecas por CDN:** jsPDF, SheetJS, ExcelJS, pdf.js e mammoth ainda vêm de CDN, com versão fixa.
