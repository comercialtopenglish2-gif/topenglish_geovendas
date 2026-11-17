# Guia: auditar, versionar e publicar o GeoVenda (GitHub + Railway) com login obrigatório

> **Como usar este arquivo:** abra o agente de IA que você usa para mexer no projeto (Claude Code, Cursor, Codex etc.), coloque na pasta do projeto este arquivo **e o `INTEGRACAO_API_FRONT.md`** (o agente vai movê-lo para `docs/`) e diga:
> **"Leia o GUIA-DEPLOY-RAILWAY.md e o INTEGRACAO_API_FRONT.md e execute as Fases 1 a 4, uma de cada vez, parando nos pontos de parada e me avisando ao fim de cada fase."**
>
> As seções marcadas **[AGENTE]** são instruções para a IA. As marcadas **[VOCÊ]** são passos que só você pode fazer (criar contas, clicar em botões, configurar DNS, tomar decisões).

---

## Contexto

- O sistema se chama **GeoVenda** e foi criado no ambiente de artefatos do Claude.
- É um **site de front-end puro**: um `index.html` com JavaScript puro (sem React/Vue, sem etapa de build) mais um `templates.js` com planilhas modelo da rede em base64.
- Objetivo: ter o código num **repositório GitHub**, publicado automaticamente no **Railway**, num **domínio/subdomínio próprio**, com **toda alteração futura commitada e enviada automaticamente**.
- **Requisito novo e inegociável: nenhuma área, módulo ou arquivo do sistema pode ser acessado sem autenticação.** A autenticação é feita na **API do Top English CMS**, conforme o `INTEGRACAO_API_FRONT.md`, com três tipos de usuário:

| `role_id` | Quem é | Escopo no CMS |
|---|---|---|
| `1` | Franqueador (`super_admin`) | Todas as unidades |
| `2` | Master franqueado | Só a `unit_id` dele |
| `3` | Professor (subfranqueado) | Só as turmas dele, na unidade dele |

Qualquer outro `role_id` ou usuário com `status = desativado` é recusado pelo CMS (`403`).

### Pontos de atenção já identificados (confirme na Fase 1)

1. O `index.html` faz `fetch` em `data/estados.json`, `data/<UF>.json` e `bairros/<UF>.json`. **Essas pastas precisam estar no projeto**, senão mapa e dados não carregam.
2. **Dependência do ambiente Claude (`window.claude.use(...)`).** Numa leitura inicial, o código usa quatro recursos que só existem dentro do Claude:
   - `"user"`: identidade do usuário logado (`me()`, `id()`, `isOwner()`, `profiles()`, `search()`).
   - `"db"`: banco compartilhado estilo Firestore (`doc`, `collection`, `onSnapshot`, `where`), usado em coleções como `acessos`, `solicitacoes`, `config`, `relatorios`, `fontes`, `horarios`, `equipe`, `vendedor/*`, `data/users/<uid>` e nos espaços por unidade do módulo de funil.
   - `"sample"`: chamadas de IA (`sample.json(prompt, {...})`), usadas em vários módulos.
   - `"downloads"`: salvar CSV, PDF e Excel (`downloads.save(...)`).
   
   Sem o Claude, o código cai num "modo local" (sem conta, sem banco compartilhado). **Esse modo local não pode ir para produção**, porque ele libera o sistema sem login (ver item 4).
3. Bibliotecas são carregadas por CDN (jsPDF, SheetJS, ExcelJS, mammoth, pdf.js). Funciona, mas depende de internet e de versões publicadas.
4. **O portão de login atual é o do Claude e é só visual.** O `index.html` tem um portão (`GV_GATE`, `iniciar()`, painel `Master`) que usa contas do Claude, domínio de e-mail, pedido de acesso por estado e aprovação do MASTER. Ele precisa ser **substituído** pelo login do CMS. Além disso, num site estático servido por Caddy, **qualquer pessoa que souber a URL baixa `index.html`, `templates.js` e `data/*.json` sem logar**; um portão só no front não protege os arquivos (e `templates.js` contém as planilhas modelo da rede). Por isso o guia usa um **servidor gateway** (Fase 2) em vez de Caddy puro.
5. **Dados que já existem no banco do Claude não vêm junto com o código.** Se a sua amiga já tem dados reais cadastrados (leads, pesquisas, relatórios, equipe), eles ficam no banco do ambiente Claude. Confirme com ela antes do deploy se há algo a exportar.

---

## Pontos de parada obrigatórios **[AGENTE]**

O agente **para e espera minha resposta** nestes momentos. Não avança sozinho:

1. Depois da Fase 1 (`STACK.md` pronto): mostrar resumo e pendências.
2. Depois do `STACK.md`: fazer as **perguntas D1 a D5** (seção "Decisões").
3. Antes de alterar qualquer linha do portão de login, da camada `window.claude` ou das regras de acesso no `index.html`.
4. Antes do primeiro `git push`.
5. Antes de qualquer mudança em `server/auth.js`, `server/roles.js` ou regras de acesso a dados, depois que o sistema estiver no ar.

---

## Fase 1: Auditoria da stack **[AGENTE]**

Analise todos os arquivos da pasta do projeto e gere um arquivo **`STACK.md`** na raiz contendo:

1. **Tipo de aplicação:** estática, SPA, SSR, com backend? Qual o ponto de entrada?
2. **Linguagens e frameworks** detectados (e como você detectou).
3. **Dependências:**
   - Locais (`package.json`, `requirements.txt` etc., se existirem).
   - Externas por CDN: liste cada URL, biblioteca e versão. Marque as que estão **sem versão fixa** (ex.: `.../npm/xlsx` sem `@versão`) e sugira fixar.
4. **Arquivos de dados e assets:** liste todos os caminhos que o código carrega (`fetch`, `src`, `href`, `import`, carregamento dinâmico de scripts) e **confira se cada um existe na pasta**. Liste os que estão faltando.
5. **Dependências do ambiente Claude:** procure por `window.claude`, `claude.use`, `window.storage`, `window.fs` e chamadas à API da Anthropic. Monte uma **tabela por módulo** (portão de login, radar, vendedor, funil/unidades, assistente etc.) com: capacidade usada (`user`, `db`, `sample`, `downloads`), **métodos exatos chamados**, e **o que deixa de funcionar fora do Claude**.
6. **Inventário do banco (`db`):** liste **todas as coleções e documentos** lidos/escritos (caminho, quem escreve, quem lê, se é privado por usuário ou compartilhado, se usa `onSnapshot` ou `where`) e **os códigos de erro tratados** (ex.: `invalid_argument`, `quota_exceeded`). Esse inventário vai definir as regras de acesso do servidor na Fase 2.
7. **Mapa de autenticação e papéis atuais:** descreva o fluxo do portão de hoje (quem é MASTER, como uma unidade pede acesso, como o estado/UF é travado, o que muda por tipo de usuário) e **onde cada decisão de permissão está no código** (arquivo e linha aproximada).
8. **Armazenamento local:** quais chaves de `localStorage`/`sessionStorage`/`IndexedDB` são usadas e quais pertencem a uma conta (devem ser limpas na troca de conta).
9. **Segredos:** procure chaves de API, tokens ou senhas no código. **Nunca** copie os valores no relatório, só informe arquivo e linha.
10. **Tamanho e riscos:** arquivos grandes (>1 MB), recursos que bloqueiam o carregamento, qualquer coisa que impeça o deploy.
11. **Conferência da API de login:** confira que `GET https://cms.topenglish.com.br/admin/health` responde `{"status":"ok", ...}` (rota pública). **Não teste login com senha real sem eu pedir**, e nunca grave credenciais em arquivo.
12. **Conclusão:** arquitetura recomendada e lista de pendências antes do deploy.

Ao terminar, me mostre o resumo e as pendências. **Não altere o código ainda.**

### Decisões que o agente deve me perguntar ao final da Fase 1 **[AGENTE pergunta, VOCÊ decide]**

Pergunte uma por vez, explicando prós e contras em linguagem simples, com a **recomendação** abaixo como ponto de partida:

| # | Decisão | Opções | Recomendação |
|---|---|---|---|
| **D1** | **Como proteger o sistema** | **(a)** Servidor gateway Node: faz o login no CMS, guarda o token em cookie seguro e só entrega os arquivos a quem está autenticado. **(b)** Caddy + portão só no front: mais simples, mas os arquivos ficam públicos para quem souber a URL, e exige liberar o domínio no CORS do CMS. | **(a)** |
| **D2** | **O que cada papel acessa no GeoVenda** | Proposta: `role_id 1` → MASTER (todos os estados, painéis de MASTER); `role_id 2` → unidade, travada na UF dela; `role_id 3` (professor) → **bloqueado**, com mensagem "Perfil sem acesso ao GeoVenda", **até eu definir o que ele pode ver**. | Proposta ao lado (falha fechada) |
| **D3** | **De onde vem a UF/cidade da unidade** | **(a)** Do campo `unit.state`/`unit.city` do login do CMS (no exemplo da documentação esses campos vêm `null`). **(b)** Tabela de-para `unit_id → UF/cidade/nome` no banco do GeoVenda, editável pelo MASTER, preenchida automaticamente quando o CMS trouxer o dado. | **(b)** |
| **D4** | **Banco de dados compartilhado** (substitui `claude.use("db")`) | **(a)** PostgreSQL no próprio Railway + API no gateway. **(b)** Supabase. **(c)** Firebase. | **(a)** |
| **D5** | **IA** (substitui `claude.use("sample")`) | **(a)** Chamar a API da Anthropic pelo gateway, com chave guardada no Railway, limite por usuário (gera **custo**). **(b)** Desligar os recursos de IA por enquanto. | Eu decido (custo) |

Registre as respostas na seção **"Decisões tomadas"** do `STACK.md`.

---

## Fase 2: Preparar o projeto para deploy **[AGENTE]**

Depois que eu aprovar o `STACK.md` e responder D1 a D5. As instruções abaixo assumem as recomendações (D1a, D4a). Se eu escolher outra, **adapte e me explique o que mudou antes de seguir**.

### 2.1 Estrutura

Tudo o que só usuário logado pode receber fica em `public/`. **O servidor nunca serve nada fora de `public/` (e `login/` na parte pública).**

```
/
├── public/                  (SÓ para autenticados)
│   ├── index.html
│   ├── templates.js
│   ├── claude-shim.js       (camada de compatibilidade, item 2.4)
│   ├── data/                (estados.json, <UF>.json ...)
│   └── bairros/             (<UF>.json ...)
├── login/                   (única parte pública)
│   ├── login.html
│   ├── login.js
│   └── login.css
├── server/
│   ├── server.js            (rotas, estáticos, healthcheck)
│   ├── auth.js              (login, sessão, cache de validação)
│   ├── roles.js             (ÚNICO lugar com o mapa role_id -> permissões do GeoVenda)
│   ├── db.js                (acesso ao Postgres e regras por coleção)
│   ├── ai.js                (proxy da IA, se D5a)
│   ├── migrations/001_init.sql
│   └── dev/mock-cms.js      (CMS falso para testar localmente; fora do Docker)
├── docs/INTEGRACAO_API_FRONT.md
├── package.json / package-lock.json
├── Dockerfile
├── .gitignore
├── .dockerignore
├── README.md
├── STACK.md
├── AGENTS.md                (regras permanentes do agente, Fase 4)
└── CLAUDE.md                (mesmo conteúdo, se for Claude Code)
```

### 2.2 Gateway de autenticação (D1a)

Crie `server/server.js` em **Node 20** (usar o `fetch` nativo), com **`express`** e **`pg`** como dependências, **versões fixas e `package-lock.json` commitado**. Requisitos:

**Variáveis de ambiente** (nunca no código): `CMS_BASE_URL` (padrão `https://cms.topenglish.com.br`), `PORT` (o Railway injeta), `NODE_ENV`, `DATABASE_URL` (D4a), `ANTHROPIC_API_KEY` (D5a). Crie `.env.example` sem valores reais.

**Rotas públicas** (e somente estas):
- `GET /healthz` → `{ "status": "ok" }` (healthcheck do Railway).
- `GET /login` e os arquivos de `login/`.
- `POST /auth/login` e `POST /auth/logout`.

**Todo o resto exige sessão válida.** Sem sessão: página HTML → redireciona para `/login?next=<caminho>`; `fetch`/`/api/*` → `401` em JSON. Aceite `next` **somente** se for caminho relativo que começa com um único `/` (nunca `//` nem URL completa), para evitar redirecionamento aberto.

**`POST /auth/login`** (corpo `{ email, password }`):
1. Repasse para `POST {CMS_BASE_URL}/admin/auth/login` (servidor para servidor, **por isso não há CORS a configurar no CMS**).
2. `401`/`403` do CMS: devolva o `message` do CMS ao usuário, sem detalhes extras. Falha de rede: `502` com mensagem genérica em português.
3. `200`: confira se o `role_id` está liberado em `server/roles.js` (D2). Se não estiver, **não crie sessão** e devolva `403` "Perfil sem acesso ao GeoVenda".
4. Crie o cookie `gv_session` com o JWT do CMS: **`HttpOnly`, `Secure` (em produção), `SameSite=Lax`, `Path=/`, `Max-Age` = `expires_in_hours` × 3600** (24 h). O JS do navegador **nunca** vê o token.
5. Registre/atualize a pessoa na tabela `pessoas` (`id`, `nome`, `email`, `role_id`, `unit_id`, `ultimo_login`) para alimentar `profiles()` e a busca do MASTER. **Nunca grave a senha.**
6. **Limite de tentativas:** por IP + e-mail, p. ex. 10 em 15 minutos (em memória basta no começo). Use `trust proxy` por causa do Railway.

**Validação em cada requisição protegida:**
- Chame `GET {CMS_BASE_URL}/admin/auth/me` com `Authorization: Bearer <jwt do cookie>` e guarde o resultado em memória por **60 s**, chaveado pelo hash do token. Não decodifique o JWT para decidir permissão (o papel real vem do `/me`, como o `INTEGRACAO_API_FRONT.md` manda).
- `401` do CMS: apague o cookie e mande para o login (token expirado depois de 24 h é comportamento esperado; **não existe refresh**).
- CMS fora do ar e cache vencido: **falha fechada** (`503`, "Não consegui validar seu acesso agora. Tente novamente."). Nunca liberar por padrão.
- Usuário desativado no CMS perde o acesso em até ~1 minuto (confirme com o time do CMS que o `/me` também recusa desativados; se não recusar, avise-me).

**Unidade ativa:** `role_id 2` fica sempre preso à `unit_id` dele. Só `role_id 1` escolhe unidade (`X-Active-Unit-Id` + `?unit_id=` somente em chamadas ao CMS, nunca para "abrir" outra unidade no master). Em `403` do CMS, **não tente de novo com outro header**.

**`GET /api/session`:** devolve `{ user, unit, capabilities, geovenda: { papel, uf, cidade, unidade, master } }`, montado a partir do `/me` e de `server/roles.js` + D3. É a **única fonte de identidade do front**.

**Arquivos estáticos:** servir só `public/`, sem listagem de diretório, sem arquivos ocultos (`.env`, `.git`), `Cache-Control: private, no-store` para HTML e `private` para dados. Headers de segurança: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`. (CSP fica como melhoria futura, porque o `index.html` usa scripts inline.)

**Logs:** nunca registre corpo de login, senha, token nem cookie.

**Rotas legadas do CMS são proibidas:** não usar `GET /v1/authentication` (senha na query string) nem `POST /v2/webbook/login`. Token **nunca** em query string.

### 2.3 Regras de acesso (D2 e D3) em `server/roles.js`

Um único arquivo com o mapa abaixo (ajustado às minhas respostas). Nenhum outro arquivo decide permissão por `role_id`:

```js
// Exemplo da proposta D2. Ajustar conforme minha decisão.
export const PAPEIS = {
  1: { papel: "master",  todosEstados: true  },   // franqueador
  2: { papel: "unidade", todosEstados: false },   // master franqueado: UF travada
  // 3 (professor): ausente = bloqueado
};
```

A UF/cidade/nome da unidade vêm da tabela de-para (D3b) ou do `unit` do CMS. Se uma unidade `role_id 2` **não tiver UF resolvida**, o sistema mostra "Sua unidade ainda não tem estado configurado. Fale com o MASTER" e **não libera dados** (falha fechada).

### 2.4 Camada de compatibilidade `public/claude-shim.js` (D4, D5)

Para **não reescrever o `index.html` inteiro**, crie `public/claude-shim.js`, carregado **antes** do script principal, que define `window.claude.use(nome)` com a mesma interface que o código já usa:

- **`"user"`:** `me()` → `{ id, name, email, avatarUrl: null, isOwner: <role_id 1> }` a partir de `/api/session`; `id()`, `isOwner()`; `profiles(ids)` e `search(q)` consultam a tabela `pessoas` (só aparecem pessoas que já fizeram login pelo menos uma vez; documente essa limitação). `search` só para o MASTER.
- **`"db"`:** adaptador estilo Firestore (`doc().get/set/update/delete/onSnapshot`, `collection().get/doc/where/onSnapshot`, `metadata.fromCache`) sobre `/api/db/*` do gateway, com os documentos em Postgres (`docs(path text primary key, colecao text, dados jsonb, atualizado_em timestamptz, versao int)`). `onSnapshot` por **polling** (ex.: 4 s, só quando a aba está visível) usando a versão para não reprocessar sem mudança. Preserve os **códigos de erro** que o front trata (`invalid_argument` = somente leitura; `quota_exceeded`).
- **`"sample"` (D5a):** `json(prompt, opts)` e `limits()` chamam `/api/ai/*`, e o gateway chama a API da Anthropic com a chave do servidor. Mapeie `modelTier` (`quick`/`complex`) para modelos **consultando a documentação atual da Anthropic** (não use nomes de memória), com limite de tokens e de chamadas por usuário. Se D5b, `use("sample")` devolve `null` e o front já desativa os botões de IA.
- **`"downloads"`:** `save({ filename, data })` cria um `Blob` e dispara o download no navegador, devolvendo `{ status: "saved" }` (e rejeitando com `code: "declined"` se o usuário cancelar).
- **Sessão expirada:** em qualquer `401` das chamadas `/api/*`, o shim redireciona para `/login?next=...`.

**Regras de acesso a dados ficam no servidor** (`server/db.js`), nunca só no shim. Derive-as do **inventário do banco da Fase 1**, com este princípio:
- Documentos privados do usuário (`data/users/<uid>/*`, `pedidos/<uid>`, `monitor/<uid>` e similares): só o dono lê/escreve; o MASTER (`role_id 1`) só lê se o inventário mostrar que o código atual já permite.
- Coleções compartilhadas (`relatorios`, `horarios`, `equipe` etc.): leitura para autenticados; escrita conforme o código atual.
- Configurações globais (`config/*`, `vendedor/metodo`, `vendedor/topenglish`, `fontes`): **só MASTER escreve**.
- Dados por unidade (módulo de funil): `role_id 2` só acessa o espaço da **própria** unidade; `role_id 1` escolhe qualquer uma. O identificador do espaço passa a ser derivado da `unit_id` do CMS, não mais do id da conta Claude.
- Limites de tamanho por documento e por usuário, para a mensagem `quota_exceeded` continuar fazendo sentido.

### 2.5 Ajustes mínimos no `index.html` **(ponto de parada 3: peça minha confirmação antes)**

Altere só o necessário:
1. Carregar `claude-shim.js` antes do script principal.
2. **Remover o "modo local"** do `iniciar()`: sem sessão, nunca liberar a tela.
3. Trocar o portão (telas "semconta", "dominio", "pedir", "aguardando", "suspenso") por: sessão válida + regras do `roles.js`. O pedido de acesso por estado e a aprovação por MASTER deixam de existir; o painel MASTER mantém só o que continuar fazendo sentido (de-para de unidades, D3b), e **você me mostra a proposta antes de apagar qualquer funcionalidade**.
4. Manter a limpeza de cache por conta (`trocaDeConta`) usando o id da pessoa do CMS.
5. Adicionar botão **Sair** (`POST /auth/logout`) e mostrar quem está logado (nome, papel, unidade).

### 2.6 Dockerfile, ignores e README

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
CMD ["node", "server/server.js"]
```

- **`.gitignore`:** `.env`, `.DS_Store`, `node_modules/`, arquivos temporários.
- **`.dockerignore`:** `.git`, `node_modules`, `*.md`, `.env`, `server/dev`.
- **`README.md`:** o que é o sistema, como rodar localmente (item 2.7), como é publicado, **como funciona o login e os papéis**, variáveis de ambiente, e limitações conhecidas.

### 2.7 Testes locais (sem usar senhas reais)

Crie `server/dev/mock-cms.js`: um CMS falso que implementa `POST /admin/auth/login`, `GET /admin/auth/me` e `GET /admin/health` com **três usuários de teste** (um por `role_id`), no mesmo formato do `INTEGRACAO_API_FRONT.md`. Rode o gateway com `CMS_BASE_URL=http://localhost:4000`. Em desenvolvimento (HTTP), o cookie `Secure` fica desligado só quando `NODE_ENV !== "production"`.

Rode e **me mostre o resultado** desta **matriz de testes**:

| Teste | Resultado esperado |
|---|---|
| Abrir `/`, `/templates.js`, `/data/AL.json`, `/bairros/AL.json` sem login | Redireciona para `/login` (HTML) ou `401` (arquivos/API); **nada** do conteúdo vaza |
| Abrir `/server/server.js`, `/.env`, `/STACK.md`, `/docs/...`, `/../` | `404` ou `401`, nunca o arquivo |
| Senha errada | Mensagem do CMS, sem criar cookie |
| Login `role_id 1` | Entra como MASTER, vê todos os estados |
| Login `role_id 2` | Entra travado na UF da unidade dele; não consegue trocar de UF |
| Login `role_id 3` (se D2 mantiver bloqueado) | `403` "Perfil sem acesso ao GeoVenda", sem cookie |
| Unidade `role_id 2` sem UF resolvida | Mensagem de configuração pendente, sem dados |
| Token expirado/inválido | Volta ao login |
| CMS falso desligado com cache vencido | `503`, **não** libera |
| Logout | Cookie apagado; voltar atrás no navegador não abre nada |
| Usuário A não lê documentos privados do usuário B (`/api/db`) | `403` |
| Usuário `role_id 2` não escreve em `config/*` | `403` |
| Console do navegador | Sem erros 404 em `data/` e `bairros/`, sem erros novos |

---

## Fase 3: Guia passo a passo para mim **[AGENTE gera, VOCÊ executa]**

**[AGENTE]** Gere um arquivo **`PASSO-A-PASSO.md`** em linguagem simples, com os passos abaixo, **adaptando aos nomes reais do projeto** e me acompanhando uma etapa por vez. Sempre que possível, execute você mesmo os comandos de terminal e me peça só o que exigir meu clique.

### 3.1 GitHub **[VOCÊ]**

1. Crie uma conta em <https://github.com/signup> (se já tiver, entre).
2. Crie um repositório novo: **New repository**, nome `geovenda`, visibilidade **Private** (obrigatório aqui: o código descreve as regras de acesso), **sem** marcar "Add README".
3. Instale o Git (<https://git-scm.com/downloads>) e, de preferência, o GitHub CLI (<https://cli.github.com>).
4. Autentique: no terminal, `gh auth login`, escolha GitHub.com, HTTPS, e siga o navegador.

### 3.2 Primeiro envio do código **[AGENTE executa]** (ponto de parada 4)

Antes do `git add .`, **verifique que não há segredos** (chaves, tokens, senhas, `.env`) nos arquivos e que `.gitignore` está correto, **e me mostre o resultado dessa verificação**. Só depois:

```bash
git init
git branch -M main
git add .
git commit -m "chore: versão inicial do GeoVenda"
git remote add origin https://github.com/SEU_USUARIO/geovenda.git
git push -u origin main
```

Se `git push` falhar por autenticação, peça para eu rodar `gh auth login`.

### 3.3 Railway **[VOCÊ]**

1. Acesse <https://railway.com> e clique em **Login / Start a New Project**.
2. Entre com **Continue with GitHub** (mais simples: já conecta o repositório).
3. Escolha o plano (há período de teste/crédito; confira os valores atuais no site).
4. **New Project → Deploy from GitHub repo →** selecione `geovenda`. Autorize o acesso do Railway ao repositório se pedido.
5. **Adicione o banco (D4a):** no projeto, **New → Database → Add PostgreSQL**. No serviço do GeoVenda, em **Variables**, crie `DATABASE_URL` como **referência** ao Postgres (o Railway oferece a opção "Add Reference").
6. Em **Variables**, defina também: `CMS_BASE_URL` = `https://cms.topenglish.com.br`, `NODE_ENV` = `production` e, se D5a, `ANTHROPIC_API_KEY` (**cole a chave direto no painel do Railway; nunca no chat, no código ou no GitHub**).
7. Em **Settings → Deploy → Healthcheck Path**, informe `/healthz`.
8. O Railway detecta o `Dockerfile` e faz o primeiro deploy. Aguarde ficar **Active**. Rode a migração do banco (o agente indica o comando, ou o servidor aplica `001_init.sql` ao iniciar).
9. Em **Settings → Networking → Generate Domain** para obter um endereço `*.up.railway.app`.
10. **Teste no endereço `*.up.railway.app` com uma conta real de cada tipo** (franqueador, master e, se aplicável, professor). **Digite a senha direto na tela de login**; não envie senhas ao agente. Repita a matriz da seção 2.7 que fizer sentido em produção, em especial: abrir `/`, `/templates.js` e `/data/AL.json` **sem estar logado** deve ser recusado.

### 3.4 Domínio / subdomínio próprio **[VOCÊ]**

1. No Railway: **Settings → Networking → Custom Domain**, digite o subdomínio (ex.: `geovenda.seudominio.com.br`).
2. O Railway mostrará um registro **CNAME** (nome e valor).
3. No painel de DNS de onde o domínio está registrado (Registro.br, Cloudflare, GoDaddy etc.), crie esse **CNAME** exatamente como mostrado.
4. Aguarde a propagação (minutos a algumas horas). O HTTPS é emitido automaticamente.
5. Se usar Cloudflare, deixe o registro em **"somente DNS" (nuvem cinza)** até o certificado ser emitido.
6. **Com o gateway (D1a) não é preciso pedir ao time do CMS para liberar o domínio no CORS**, porque o navegador só fala com o seu domínio e o servidor é que fala com o CMS. *Só se o D1 for (b)*, o time do CMS precisa incluir o domínio novo **nos dois lugares** citados no `INTEGRACAO_API_FRONT.md` (`config/application.rb`, no Rack::Cors, e `allowed_origin` em `app/api/topenglish/admin/v1/base.rb`).

### 3.5 Deploy automático **[VOCÊ confirma]**

Em **Settings → Source** do serviço, confirme que o repositório está conectado e a branch é **`main`**, e que o deploy automático em cada push está ativo (é o padrão para repositórios GitHub). A partir daí: **push no `main` = novo deploy.**

### 3.6 Acessos e dados antigos **[VOCÊ]**

1. Defina quem será o **MASTER** (`role_id 1`) e confirme que esses usuários existem no CMS.
2. Se a sua amiga tem dados reais no ambiente Claude, combine com ela a exportação e a importação (o agente prepara o script de importação quando houver o arquivo).
3. Se D3b: o MASTER preenche o de-para `unit_id → UF/cidade` das unidades `role_id 2` (ou o CMS passa a enviar `unit.state`/`unit.city`).

---

## Fase 4: Regras permanentes do agente **[AGENTE]**

Crie (ou atualize) na raiz do projeto o arquivo **`AGENTS.md`** e, se você for o Claude Code, também **`CLAUDE.md`** com o mesmo conteúdo, para que essas regras valham em **todas as conversas futuras**:

~~~markdown
# Regras do projeto GeoVenda

## Fluxo de trabalho (obrigatório)
Após CADA alteração concluída e testada neste projeto:
1. Rode `git status` e `git diff --stat` para conferir o que mudou.
2. Confirme que nenhum segredo (chaves, tokens, senhas, .env, cookies) está no diff.
3. `git add` apenas dos arquivos relevantes.
4. `git commit` com mensagem clara no padrão Conventional Commits em português:
   - `feat:` nova funcionalidade
   - `fix:` correção
   - `style:` visual/CSS
   - `data:` atualização de arquivos em public/data/ ou public/bairros/
   - `sec:` mudança de autenticação, papéis ou regras de acesso
   - `chore:` manutenção/config
   - `docs:` documentação
5. `git push origin main`.
6. Informe ao usuário: o que mudou, o hash do commit e que o Railway fará o deploy automaticamente.

## Regras de segurança
- NUNCA commitar `.env`, chaves de API, tokens, cookies ou senhas.
- NUNCA registrar em log senha, corpo de login, token ou cookie.
- NUNCA usar `git push --force`, `git reset --hard` ou reescrever histórico sem pedido explícito do usuário.
- Se o push falhar (autenticação, conflito), pare e explique o problema em linguagem simples. Não tente contornar.
- Alterações grandes ou arriscadas (trocar de arquitetura, remover dados, mexer em login/banco/regras de acesso) exigem confirmação do usuário antes.

## Regras de autenticação (obrigatórias)
- TODO o sistema exige login. Nenhuma rota nova pode ser pública, exceto `/healthz`, `/login`, `/auth/login` e `/auth/logout`.
- O servidor só serve arquivos de `public/` (e `login/` na parte pública). Nunca servir a raiz do projeto.
- A autenticação é a do Top English CMS (`docs/INTEGRACAO_API_FRONT.md`): `POST /admin/auth/login` e validação por `GET /admin/auth/me`. NUNCA usar as rotas legadas `/v1/authentication` e `/v2/webbook/login`.
- O token fica em cookie `HttpOnly`; nunca em `localStorage`, nunca em query string, nunca exposto ao JavaScript do front.
- NUNCA decidir permissão decodificando o JWT. O papel vem do `/me` (via `/api/session`).
- Permissões por `role_id` vivem SOMENTE em `server/roles.js`. Papel desconhecido = bloqueado (falha fechada). CMS indisponível sem cache válido = bloqueado.
- Regras de acesso a dados são aplicadas NO SERVIDOR (`server/db.js`), não só no front.
- `role_id 2` fica preso à unidade dele; só `role_id 1` escolhe unidade. Em `403` do CMS, não tentar de novo com outro `X-Active-Unit-Id`.
- Qualquer mudança em `server/auth.js`, `server/roles.js`, `server/db.js` ou no portão do `index.html` exige: confirmação do usuário, rodar a matriz de testes do README e commit com prefixo `sec:`.

## Checagem antes de commitar
- Rodar localmente com o CMS falso (`server/dev/mock-cms.js`) e verificar: sem login nada abre; cada papel vê só o que pode; sem erros novos no console.
- Verificar que todos os arquivos referenciados (`public/data/`, `public/bairros/`, `public/templates.js`) existem.

## Contexto técnico
- Front estático (HTML + JS puro) em `public/`, servido por gateway Node (Express) com login via API do Top English CMS.
- Banco: PostgreSQL no Railway (documentos JSONB), acessado pelo gateway; `public/claude-shim.js` emula `window.claude.use` (`user`, `db`, `sample`, `downloads`).
- Hospedagem: Railway, deploy automático a partir da branch `main` do GitHub.
- Veja `STACK.md` para dependências e decisões (D1 a D5), e `README.md` para rodar localmente.
~~~

### Se o seu agente não consegue rodar Git

Alguns ambientes de chat não executam comandos no seu computador. Nesse caso, use uma destas alternativas:

- **Claude Code** (terminal ou app desktop): executa `git` direto na sua pasta e respeita o `CLAUDE.md`.
- **GitHub Desktop** (<https://desktop.github.com>): você arrasta a pasta e clica em *Commit* e *Push*, e o agente só te lembra de fazer isso.
- **Edição pela web do GitHub:** só para ajustes pequenos **e que não mexam em autenticação ou segurança**; o Railway publica sozinho.

---

## Checklist final

- [ ] `STACK.md` gerado e revisado, com tabela de dependências do Claude e inventário do banco
- [ ] Decisões D1 a D5 respondidas e registradas
- [ ] Pastas `data/` e `bairros/` presentes (dentro de `public/`)
- [ ] Gateway com login via CMS funcionando localmente com o CMS falso
- [ ] Matriz de testes da seção 2.7 aprovada (nada abre sem login)
- [ ] Papéis `role_id 1`, `2` e `3` tratados conforme D2 (professor bloqueado ou liberado, conforme minha decisão)
- [ ] Dados antigos do banco do Claude: confirmado se há o que migrar
- [ ] Repositório **privado** criado no GitHub e código enviado
- [ ] Projeto criado no Railway, Postgres adicionado, variáveis configuradas e deploy **Active**
- [ ] Sistema testado no endereço `*.up.railway.app` com uma conta real de cada papel
- [ ] Arquivos (`/`, `/templates.js`, `/data/AL.json`) recusados sem login, em produção
- [ ] Subdomínio configurado (CNAME) e com HTTPS funcionando
- [ ] `AGENTS.md`/`CLAUDE.md` criados
- [ ] Teste do fluxo: pedir uma pequena alteração visual, ver o commit no GitHub e o novo deploy no Railway

## Se algo der errado

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| Site abre mas mapa/dados vazios | Faltam `public/data/` ou `public/bairros/` | Adicionar as pastas e dar push |
| Deploy falha no Railway | Erro no `Dockerfile`, `package-lock.json` ou variável faltando | Ver aba **Deploy Logs** e pedir ao agente para corrigir |
| Deploy "Active" mas reinicia sem parar | Healthcheck em caminho errado | Conferir **Healthcheck Path** = `/healthz` |
| Domínio não abre | CNAME incorreto ou propagando | Conferir o registro e aguardar; testar com o domínio `.up.railway.app` |
| `git push` recusado | Autenticação ou conflito | Rodar `gh auth login` e tentar de novo |
| Login volta para a tela de login em loop (só local) | Cookie `Secure` em `http://localhost` | Rodar com `NODE_ENV` diferente de `production` |
| `401` depois de um dia de uso | JWT do CMS vale 24 h e não há refresh | Esperado: fazer login de novo |
| `403` "Perfil sem acesso ao Admin." | `role_id` fora de 1, 2 e 3 | Ajustar o cadastro do usuário no CMS |
| `403` "Perfil sem acesso ao GeoVenda" | Papel liberado no CMS mas bloqueado em `server/roles.js` (D2) | Decidir o acesso desse papel e ajustar `roles.js` |
| `403` "Unidade fora do seu escopo." | `X-Active-Unit-Id` diferente da unidade do usuário | Não usar o header para master/professor; corrigir o código |
| Login ok, mas telas sem dados do estado | Unidade sem UF resolvida (D3) | Preencher o de-para de unidades ou pedir ao CMS os campos `state`/`city` |
| `503` "Não consegui validar seu acesso" | CMS fora do ar e cache vencido | Aguardar o CMS voltar; testar `GET /admin/health` |
| Botões de IA desativados | `ANTHROPIC_API_KEY` ausente ou D5b | Configurar a variável no Railway ou aceitar sem IA |
| Dados "somem" ao trocar de usuário no mesmo navegador | Cache local da conta anterior | Conferir `trocaDeConta` e as chaves em `CACHE_DA_CONTA` |
| Erro de CORS no navegador (só se D1b) | Domínio do GeoVenda fora da lista do CMS | Pedir ao time do CMS para incluir o domínio nos dois lugares indicados |
