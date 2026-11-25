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
- TODO o sistema exige login. Nenhuma rota nova pode ser pública, exceto `/healthz`, `/login`, `/auth/login` e `/auth/logout` e `/l/<código>` (links rastreáveis, aprovado pela usuária em 25/11/2026: só conta o clique e redireciona para o WhatsApp ou o site; não mostra nenhum dado; regras em `server/links.js`).
- O servidor só serve arquivos de `public/` (e `login/` na parte pública). Nunca servir a raiz do projeto.
- A autenticação é a do Top English CMS, em dois modos escolhidos pela variável `CMS_API`:
  - `admin` (padrão, decisão da usuária em 17/11/2026): API `/admin` de `docs/INTEGRACAO_API_FRONT.md`. Login `POST /admin/auth/login` (responde 201) e validação `GET /admin/auth/me` com Bearer, que devolve `role_id` e unidade. Hoje está em `cmsdev.topenglish.com.br`; depois vai para `cms.topenglish.com.br`.
  - `legado`: API antiga de produção (`docs/GUIA_INTEGRACAO_FRONT_API.md`): login v2 assinado no servidor (`CMS_PASSWORD_SECRET`) ou v1 servidor-a-servidor; validação por `/webbook/teacher/dashboard`; papel pela tabela `acessos` e `GV_FRANQUEADORES`.
  - Nunca chamar o CMS a partir do navegador; nunca registrar em log senha, token, cookie ou a URL do login v1.
- O navegador recebe só um id de sessão aleatório em cookie `HttpOnly`. O token do CMS fica na tabela `sessoes`, no servidor; nunca em `localStorage`, nunca em query string, nunca exposto ao JavaScript do front.
- NUNCA decidir permissão decodificando o JWT. No modo `admin` o papel vem do `role_id` de `/admin/auth/me` (1 = franqueador, 2 = master; os demais bloqueados). No modo `legado`, da tabela `acessos`. Tudo chega ao front por `/api/session`.
- Permissões por papel vivem SOMENTE em `server/roles.js`. Papel desconhecido = bloqueado (falha fechada), inclusive professores. CMS indisponível sem cache válido = bloqueado.
- Regras de acesso a dados são aplicadas NO SERVIDOR (`server/db.js`), não só no front.
- O master fica preso à unidade dele (do CMS no modo `admin`; de `acessos` no `legado`); só o franqueador vê todas. O GeoVenda não usa `X-Active-Unit-Id`.
- Qualquer mudança em `server/auth.js`, `server/roles.js`, `server/db.js`, `server/paginas/acessos.html` ou no portão do `index.html` exige: confirmação do usuário, rodar a matriz de testes do README e commit com prefixo `sec:`.

## Checagem antes de commitar
- Rodar localmente com o CMS falso (`server/dev/mock-cms.js`), banco limpo, e as matrizes `npm test` (modo admin) e `npm run test:legado` (servidor com `CMS_API=legado`): sem login nada abre; cada papel vê só o que pode; sem erros novos no console.
- Verificar que todos os arquivos referenciados (`public/data/`, `public/bairros/`, `public/templates.js`) existem.

## Contexto técnico
- Front estático (HTML + JS puro) em `public/`, servido por gateway Node (Express) com login via API do Top English CMS.
- Banco: PostgreSQL no Railway (documentos JSONB), acessado pelo gateway; `public/claude-shim.js` emula `window.claude.use` (`user`, `db`, `sample`, `downloads`).
- Hospedagem: Railway, deploy automático a partir da branch `main` do GitHub.
- Veja `STACK.md` para dependências e decisões (D1 a D5), e `README.md` para rodar localmente.

## Particularidades deste projeto
- `public/index.html` não carrega o shim sozinho: o servidor injeta `window.GV_SESSION` e `<script src="claude-shim.js">` logo após `<head>` a cada requisição (`server/server.js`, função `indexComSessao`).
- Em `/acessos` (`server/paginas/acessos.html`) o franqueador corrige UF e cidade das unidades (modo `admin`: o CMS manda o estado por extenso, convertido em sigla por `ufDe` em `server/roles.js`) e, no modo `legado`, também libera pessoas.
- O master só recebe `data/<UF>.json` e `bairros/<UF>.json` da UF da própria unidade (regra no `server/server.js`).
- Campanhas e brindes é a página `public/campanhas.html`, servida em `/campanhas` com a mesma injeção de sessão e aberta num iframe em Medir (`#view-camp` no `index.html`). As regras por unidade (`unidades`, `participacoes`, `estoque`, dono = `u<unit_id>`) ficam em `server/db.js`. O `X-Frame-Options` é `SAMEORIGIN` por causa desse iframe.
- Em Campanhas e brindes, o franqueador escolhe entrar **como Unidade** (a unidade da conta dele no CMS, `POST /api/campanhas/unidade`) ou **como Franqueadora** (todas as unidades, com o código em `CAMP_CODIGO_REDE`, `POST /api/campanhas/rede`; o valor fica só no Railway, nunca no código ou no Git). A escolha fica na sessão (`sessoes.camp_unidade`, `sessoes.rede_camp`) até sair do sistema ou trocar (`POST /api/campanhas/sair`); o escopo efetivo é `id.campEscopo` (`rede`, `u<unitId>` ou nulo). O master nunca vê a rede, mesmo com o código.
