# Passo a passo · colocar o GeoVenda no ar

Siga na ordem. Onde está **[VOCÊ]**, só você pode fazer. Onde está **[AGENTE]**, a IA faz.

## 1. GitHub [VOCÊ]

1. Entre em https://github.com/signup e crie a conta (ou entre na sua).
2. Clique em **New repository**:
   - nome: `geovenda`;
   - visibilidade: **Private** (obrigatório);
   - **não** marque "Add README".
3. Mande para o agente o endereço do repositório (ex.: `https://github.com/seu-usuario/geovenda`).

## 2. Primeiro envio do código [AGENTE]

O agente:
1. confere que não há senhas, chaves ou `.env` nos arquivos e mostra o resultado para você;
2. só depois roda `git push` para o repositório privado.

## 3. Railway [VOCÊ]

1. Acesse https://railway.com e clique em **Login** → **Continue with GitHub**.
2. Escolha o plano. Confira os valores atuais no site; há crédito de teste.
3. **New Project → Deploy from GitHub repo →** escolha `geovenda` e autorize o acesso se o Railway pedir.
4. No projeto, clique em **New → Database → Add PostgreSQL**.
5. Clique no serviço **geovenda → Variables** e crie:
   - `DATABASE_URL` → **Add Reference** → escolha o Postgres;
   - `CMS_BASE_URL` = `https://cmsdev.topenglish.com.br` (ambiente com a API `/admin`; quando ela chegar ao CMS oficial, troque para `https://cms.topenglish.com.br`);
   - `CMS_API` = `admin` (é o padrão; só use `legado` se precisar voltar para a API antiga).
   - `NODE_ENV` = `production`;
   - `ANTHROPIC_API_KEY` = sua chave da Anthropic. Crie em https://console.anthropic.com e **cole direto no Railway**. Nunca mande a chave no chat, no código ou no GitHub.
   - Opcional: `AI_DAILY_CALLS` = limite de chamadas de IA por pessoa por dia (padrão 150).
6. Em **Settings → Deploy → Healthcheck Path**, escreva `/healthz`.
7. Espere o deploy ficar **Active**. O banco é criado sozinho na primeira vez.
8. Em **Settings → Networking → Generate Domain**, pegue o endereço `…up.railway.app`.

## 4. Primeiro teste no ar [VOCÊ]

1. Abra o endereço `…up.railway.app`. Ele deve mandar para a tela de login.
2. Entre com a sua conta de **franqueador** do sistema da Top English. Digite a senha só na tela de login.
3. No menu, clique em **Unidades e acessos** (ou abra `…/acessos`) e confira o estado (UF) de cada unidade que aparecer. Corrija se precisar.
4. Peça a um master para entrar. Ele deve ver só o estado e a unidade dele, conforme o cadastro no sistema da Top English.
5. Sem estar logado (numa janela anônima), abra `…/templates.js` e `…/data/MG.json`. As duas devem mandar para o login.

## 5. Domínio próprio [VOCÊ]

1. No Railway: **Settings → Networking → Custom Domain** e digite, por exemplo, `geovenda.seudominio.com.br`.
2. O Railway mostra um registro **CNAME** (nome e valor).
3. No painel onde o domínio está (Registro.br, Cloudflare, GoDaddy…), crie esse CNAME exatamente igual.
4. Espere a propagação (minutos a algumas horas). O HTTPS sai sozinho.
5. Se usar Cloudflare, deixe a nuvem **cinza** (somente DNS) até o certificado sair.

Não é preciso pedir nada ao time do CMS: o navegador fala só com o seu domínio, e é o servidor que fala com o CMS.

## 6. Deploy automático [VOCÊ confirma]

Em **Settings → Source**, confira que o repositório é `geovenda`, na branch `main`. A partir daí, cada envio de código vira um deploy novo sozinho.

## 7. Dados que estão hoje no Claude [VOCÊ decide]

Leads, perfis, treinos e funil cadastrados no GeoVenda de dentro do Claude **não vêm junto com o código**. Se houver dados reais a manter, avise o agente: ele prepara a exportação e a importação.

## Se algo der errado

| Sintoma | O que fazer |
|---|---|
| Deploy falha | Railway → **Deploy Logs** e mande o erro ao agente |
| Fica reiniciando | conferir **Healthcheck Path** = `/healthz` e se `DATABASE_URL` está como referência ao Postgres |
| "Perfil sem acesso ao GeoVenda" | é professor ou outro perfil que não é franqueador nem master no sistema da Top English |
| "O login está mal configurado no servidor" | a `CMS_PASSWORD_SECRET` está errada: corrija ou apague a variável |
| "Não consegui validar seu acesso agora" | o CMS da Top English está fora do ar; espere e tente de novo |
| Botões de IA desativados | falta `ANTHROPIC_API_KEY` no Railway |
| Pede login de novo depois de um dia | normal: o login do CMS vale 24 h |
