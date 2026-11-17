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
- Rodar localmente com o CMS falso (`server/dev/mock-cms.js`) e a matriz `npm test` (`server/dev/test-matrix.js`): sem login nada abre; cada papel vê só o que pode; sem erros novos no console.
- Verificar que todos os arquivos referenciados (`public/data/`, `public/bairros/`, `public/templates.js`) existem.

## Contexto técnico
- Front estático (HTML + JS puro) em `public/`, servido por gateway Node (Express) com login via API do Top English CMS.
- Banco: PostgreSQL no Railway (documentos JSONB), acessado pelo gateway; `public/claude-shim.js` emula `window.claude.use` (`user`, `db`, `sample`, `downloads`).
- Hospedagem: Railway, deploy automático a partir da branch `main` do GitHub.
- Veja `STACK.md` para dependências e decisões (D1 a D5), e `README.md` para rodar localmente.

## Particularidades deste projeto
- `public/index.html` não carrega o shim sozinho: o servidor injeta `window.GV_SESSION` e `<script src="claude-shim.js">` logo após `<head>` a cada requisição (`server/server.js`, função `indexComSessao`).
- O de-para de unidades (UF/cidade) é editado pelo franqueador em `/unidades`.
- `role_id 2` só recebe `data/<UF>.json` e `bairros/<UF>.json` da UF da própria unidade (regra no `server/server.js`).
