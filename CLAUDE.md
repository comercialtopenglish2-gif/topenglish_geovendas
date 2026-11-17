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
- A autenticação é a da API que está EM PRODUÇÃO no Top English CMS (`docs/GUIA_INTEGRACAO_FRONT_API.md`, decisão da usuária em 17/11/2026): login v2 `POST /v2/webbook/login` com payload assinado no servidor (`CMS_PASSWORD_SECRET`) e, sem essa chave, login v1 `GET /v1/authentication` chamado só servidor-a-servidor. A validação contínua é `GET /webbook/teacher/dashboard` com Bearer. Nunca chamar essas rotas a partir do navegador, nunca registrar em log a URL do login v1. O namespace `/admin` (`docs/INTEGRACAO_API_FRONT.md`) ainda não existe em produção.
- O navegador recebe só um id de sessão aleatório em cookie `HttpOnly`. O token do CMS fica na tabela `sessoes`, no servidor; nunca em `localStorage`, nunca em query string, nunca exposto ao JavaScript do front.
- NUNCA decidir permissão decodificando o JWT. A API de produção não informa papel nem unidade: o papel vem da tabela `acessos` do GeoVenda (editada pelo franqueador em `/acessos`) e de `GV_FRANQUEADORES`, via `/api/session`.
- Permissões por papel vivem SOMENTE em `server/roles.js`. Quem não está em `acessos` = bloqueado (falha fechada), inclusive professores. CMS indisponível sem cache válido = bloqueado.
- Regras de acesso a dados são aplicadas NO SERVIDOR (`server/db.js`), não só no front.
- O master fica preso à unidade dele (definida em `acessos`); só o franqueador vê todas. Não existe header de unidade na API de produção do CMS.
- Qualquer mudança em `server/auth.js`, `server/roles.js`, `server/db.js`, `server/paginas/acessos.html` ou no portão do `index.html` exige: confirmação do usuário, rodar a matriz de testes do README e commit com prefixo `sec:`.

## Checagem antes de commitar
- Rodar localmente com o CMS falso (`server/dev/mock-cms.js`) e a matriz `npm test` (`server/dev/test-matrix.js`): sem login nada abre; cada papel vê só o que pode; sem erros novos no console.
- Verificar que todos os arquivos referenciados (`public/data/`, `public/bairros/`, `public/templates.js`) existem.

## Contexto técnico
- Front estático (HTML + JS puro) em `public/`, servido por gateway Node (Express) com login via API do Top English CMS.
- Banco: PostgreSQL no Railway (documentos JSONB), acessado pelo gateway; `public/claude-shim.js` emula `window.claude.use` (`user`, `db`, `sample`, `downloads`).
- Hospedagem: Railway, deploy automático a partir da branch `main` do GitHub.
- Veja `STACK.md` para dependências e decisões (D1 a D5), e `README.md` para rodar localmente.

## Particularidades deste projeto
- `public/index.html` não carrega o shim sozinho: o servidor injeta `window.GV_SESSION` e `<script src="claude-shim.js">` logo após `<head>` a cada requisição (`server/server.js`, função `indexComSessao`).
- Unidades (nome/UF/cidade) e acessos (e-mail, papel, unidade) são editados pelo franqueador em `/acessos` (`server/paginas/acessos.html`).
- O master só recebe `data/<UF>.json` e `bairros/<UF>.json` da UF da própria unidade (regra no `server/server.js`).
