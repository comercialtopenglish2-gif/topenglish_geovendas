# STACK.md · Auditoria do GeoVenda (Fase 1)

Base auditada: versão publicada `1794518224-f09a` do artefato GeoVenda (17/11/2026). Os 55 arquivos foram baixados e conferidos por SHA-256: `index.html`, `templates.js`, `data/` (28 arquivos) e `bairros/` (25 arquivos). Total: 11 MB.

## 1. Tipo de aplicação

- Front-end estático, sem backend e sem etapa de build.
- Ponto de entrada: `index.html` (933 KB), com todo o HTML, CSS e JavaScript inline.
- `templates.js` (437 KB) é carregado sob demanda pelo módulo de funil (`libs()`, global `GF_TPL`). Contém as planilhas modelo da rede em base64.
- O app é uma casca única (menu `#gvNav`) com módulos isolados:

| Módulo | Linhas no `index.html` | Tamanho | Isolamento |
|---|---|---|---|
| PDFs (logo e página final CNC) | 634–661 | 1 KB | global (`GV_PDF_LOGO`, `GV_PDF_FINAL`) |
| Identidade e filtro de nomes | 662–704 | 2 KB | global (`GV_ID`, `GV_WRAP`, `GV_LIMPAR`) |
| Radar de praças (Mercado, Demanda, Prospecção) | 706–1903 | 121 KB | IIFE |
| Vendedor (Atendimento até Medir) | 3043–6185 | 333 KB | shadow DOM `#vendHost` |
| GeoFunil (funil da escola) | 6536–7690 | 146 KB | shadow DOM `#funilHost` |
| Casca e menu | 7691–7741 | 5 KB | IIFE |
| Assistente de IA (botão flutuante) | 7888–8302 | 52 KB | IIFE |

## 2. Linguagens e frameworks

HTML5, CSS e JavaScript puro (ES2020+: `async/await`, `?.`, `??`, shadow DOM). Não há React, Vue nem bundler. Detecção: não há `package.json`, `import`, JSX nem pasta `node_modules`; todo o código está inline no `index.html`.

## 3. Dependências

Locais: nenhuma (não há `package.json`).

Externas por CDN, todas com versão fixa:

| Biblioteca | Versão | URL | Carregamento |
|---|---|---|---|
| jsPDF | 2.5.1 | cdnjs `ajax/libs/jspdf/2.5.1/jspdf.umd.min.js` | `<script>` no `<head>` |
| jspdf-autotable | 3.8.2 | jsdelivr `npm/jspdf-autotable@3.8.2` | dinâmico |
| SheetJS (xlsx) | 0.18.5 | cdnjs e jsdelivr `npm/xlsx@0.18.5` | dinâmico |
| ExcelJS | 4.4.0 | cdnjs `ajax/libs/exceljs/4.4.0` | dinâmico |
| mammoth | 1.6.0 | jsdelivr `npm/mammoth@1.6.0` | dinâmico (leitura de .docx) |
| pdf.js | 3.11.174 | jsdelivr `npm/pdfjs-dist@3.11.174` (lib e worker) | dinâmico (leitura de PDF) |
| Google Fonts | — | Barlow Condensed, Public Sans, JetBrains Mono | `<link>` |

Nenhuma está sem versão. Sugestão para depois do deploy: copiar as bibliotecas para `public/vendor/`, para não depender das CDNs.

## 4. Arquivos de dados e assets

| Caminho carregado | Onde | Existe? |
|---|---|---|
| `data/estados.json` | Radar, `fetch` | sim |
| `data/<UF>.json` | Radar, `fetch` | sim, 27 UFs |
| `bairros/<UF>.json` | Radar, `fetch` com falha tolerada (`{}`) | 25 UFs. **Faltam `DF` e `TO`**: hoje caem em `{}` sem quebrar, mas geram 404 no console |
| `templates.js` | GeoFunil, script dinâmico | sim |

- Imagens: a logo está embutida em base64 no próprio HTML. Não há imagens externas.
- Arquivos acima de 1 MB: `data/MG.json` (1,3 MB). Os mais próximos são `data/SP.json` (0,96 MB) e o `index.html` (0,93 MB).

## 5. Dependências do ambiente Claude

Não há uso de `window.storage`, `window.fs` nem chamadas diretas à API da Anthropic. Tudo passa por `window.claude.use(nome)`:

| Módulo | Capacidade | Métodos chamados | O que deixa de funcionar fora do Claude |
|---|---|---|---|
| Radar | `db` | `collection().onSnapshot`, `doc().get/set/delete`, `collection().add` | pedidos e relatórios, fontes, horários e mídias, monitores, dicas e palavras salvas, calibração |
| Radar | `sample` | `sample.json(prompt,{cache,modelTier})` | Dicas da praça, palavras-chave, relatórios com IA |
| Radar | `downloads` | `save({filename,data})` | CSV e PDF |
| Vendedor | `user` | `id()`, `canEdit()`, `profiles(ids)` | conta por usuário, aba Método (editor), nomes no painel da equipe |
| Vendedor | `db` | `collection("data/users/<uid>").get`, `doc().get/set/delete`, `onSnapshot` | leads, perfis, treinos, coaching, configurações, equipe |
| Vendedor | `sample` | `sample(input,{onText,signal,images,cache,modelTier})` com texto em streaming, conversa com várias mensagens e imagens; `sample.json(...)`; `sample.limits()` | **todas as telas de IA**: scripts, Simulador (8 modos), Análise de print (imagem), coaching, previsão, objeções, importação por PDF |
| Vendedor | `downloads` | `save` | PDFs (agenda, oferta etc.) e planilhas |
| GeoFunil | `user` | `id()`, `isOwner()`, `can("data.write")` | espaço por conta, visão de todas as escolas (dono), modo somente leitura |
| GeoFunil | `db` | `collection(P(col)).where("unidade","==",id).onSnapshot`, `doc().set/update/delete`, `collection("escolas").onSnapshot` | todos os dados do funil. Sem `db`, cai no **modo local** (`localStorage` `geofunil-local-v1`) |
| GeoFunil | `sample` | `sample(prompt,{onText,signal})`, `sample.json` | diagnóstico do funil, melhorador e avaliador de ações, sugestões |
| GeoFunil | `downloads` | `save` | exportar Excel e PDF |
| Assistente | `sample` | `sample(messages,{onText,signal})`, `limits()` | assistente inteiro |

Todas as instâncias de `sample` passam por `GV_WRAP`, que filtra nomes próprios na saída. O shim deve preservar isso: basta devolver um objeto com a mesma interface.

## 6. Inventário do banco (`db`)

| Caminho | Quem escreve | Quem lê | Escopo | `onSnapshot` / `where` |
|---|---|---|---|---|
| `data/users/<uid>/fu-*` (leads) | o próprio usuário | o próprio | privado | `get` na carga |
| `data/users/<uid>/ck-*`, `cal-*` (checklists, agendas) | próprio | próprio | privado | `get` |
| `data/users/<uid>/perfis`, `treinos`, `coach`, `cfg-qualif`, `cfg-conc`, `cfg-e2`, `cfg-e3` | próprio | próprio | privado | `get` |
| `equipe/<uid>` (resumo de follow-ups) | o próprio | gestor (dono) | compartilhado: só o gestor lê tudo | `onSnapshot` (gestor) |
| `vendedor/metodo`, `vendedor/topenglish` (textos-base) | só editor (`canEdit`) | todos | configuração global | `onSnapshot` |
| `escolas/<space>` e `escolas/<space>/unidades`, `funil`, `acoes`, `pesquisas`, `conteudos`, `influenciadores` | dono do espaço | dono do espaço; o dono do app lê todos (`collection("escolas")`) | por espaço (hoje `space = uid` do Claude) | `onSnapshot` + `where("unidade","==",…)` |
| `pedidos`, `relatorios` | qualquer usuário | todos | **compartilhado entre todos** | `onSnapshot` |
| `fontes` (+ `_meta`), `config/calibracao` | dono | todos | configuração global | `onSnapshot` |
| `monitor`, `horarios`, `proprios`, `dicas`, `palavras` | qualquer usuário | todos | **compartilhado entre todos** | `onSnapshot` |

Regras de acesso declaradas hoje no artefato: `vendedor` (todos leem, editor escreve), `equipe` (gestor lê e escreve), `equipe/{self}` (o próprio interage), `escolas` (dono), `escolas/{self}` (o próprio interage). As coleções do Radar não têm regra: qualquer pessoa com acesso lê e escreve.

Códigos de erro tratados pelo front, que o adaptador deve preservar:
- `db`: `invalid_argument` (somente leitura), `quota_exceeded`.
- `sample`: `not_granted`, `sampling_disabled`, `rate_limited`, `refused`, `cancelled`, `invalid_json`, `empty_completion`.
- `downloads`: `declined`.

Observação: o banco do Claude devolve objetos **somente leitura**. O Vendedor já clona na carga (correção de 12/11, função `limpo()`) e o GeoFunil já usa `clone()`. Ainda assim, o adaptador novo deve devolver objetos comuns, que possam ser editados.

## 7. Autenticação e papéis hoje

**O guia descreve um portão que não existe nesta versão.** No `index.html` não há `GV_GATE`, `iniciar()`, telas "semconta", "dominio", "pedir" ou "suspenso", nem coleções `acessos` ou `solicitacoes`. O controle atual é este:

| Decisão | Onde no código | Como funciona |
|---|---|---|
| Quem pode abrir | fora do código | compartilhamento do artefato no Claude |
| Dono do app | GeoFunil ~linha 7682: `S.isOwner = await user.isOwner()` | vê todas as escolas (`collection("escolas")`) |
| Somente leitura | GeoFunil ~7681: `user.can("data.write")` | `S.readonly` |
| Editor do Método e da base Top English | Vendedor ~6136: `u.canEdit()` | mostra a aba Método |
| Gestor da equipe | regra `equipe` (admin) | painel da equipe |
| Espaço da escola | GeoFunil ~7684: `S.space = S.uid` | cada conta tem o próprio espaço |
| Sem `db` | GeoFunil ~7687 e Vendedor | **modo local**, sem login, dados só no navegador |

Não há trava por UF: qualquer usuário escolhe qualquer estado no Radar.

## 8. Armazenamento local

| Chave | Módulo | É da conta? |
|---|---|---|
| `vcnc_fu`, `vcnc_perfis`, `vcnc_treinos`, `vcnc_coach`, `vcnc_hist`, `vcnc_qcfg`, `vcnc_ccfg`, `vcnc_e2cfg`, `vcnc_e3cfg`, `vcnc_ck`, `vcnc_cal`, `vcnc_ofertas`, `vcnc_ofdraft`, `vcnc_treinadores`, `vcnc_perfil` | Vendedor (`store` com prefixo `vcnc_`) | **sim**: leads e dados pessoais |
| `vcnc_aba` | Vendedor | não (preferência) |
| `geofunil-local-v1`, `geofunil-unit` | GeoFunil | **sim** |
| `geofunil-view` | GeoFunil | não |
| `gv_assist_chat`, `gv_assist_base` | Assistente | **sim** (conversa) |
| `gv_tema`, `radar_view`, `radar_prefs`, `radar_pdf` | casca e Radar | não |

**Não existe limpeza de cache ao trocar de conta (`trocaDeConta`).** Ela precisa ser criada: num computador compartilhado, os leads de uma unidade ficariam visíveis para a próxima pessoa.

## 9. Segredos

Nenhuma chave de API, token ou senha no `index.html` nem no `templates.js` (busca por `sk-ant`, `api_key`, `password` e `senha =`: 0 ocorrências).

## 10. Tamanho e riscos

- `index.html` com 933 KB inline: carrega bem, mas o CSP terá de liberar scripts inline (já previsto no guia).
- `data/MG.json` com 1,3 MB: servir com `gzip`/`brotli`, que reduz cerca de 80%.
- A IA é o centro do produto: sem `sample`, as telas principais de venda param.
- O Radar compartilha dados entre todos os usuários (pedidos, dicas, palavras, horários). No servidor novo, é preciso decidir se isso continua global ou passa a ser por unidade.
- Os dados reais estão no banco do Claude e não vêm com o código.
- A fila de **pedidos de relatório** do Radar dependia de uma rotina externa no Claude. Fora dele, os pedidos ficam parados até essa rotina ser recriada no servidor.

## 11. API de login

Não consegui testar `GET https://cms.topenglish.com.br/admin/health` daqui: a rede deste ambiente não permite esse domínio. O teste fica para a máquina que for rodar o servidor. Nenhum login foi testado e nenhuma credencial foi gravada.

## 12. Conclusão

Arquitetura recomendada, como no guia (D1a):

1. Servidor intermediário em Node 20 (Express + pg) que serve só `public/` a quem tem sessão.
2. `public/claude-shim.js` emulando `window.claude.use`:
   - `user`: `id`, `isOwner`, `can`, `canEdit`, `profiles`;
   - `db`: estilo Firestore sobre Postgres, com `where` e `onSnapshot` por polling;
   - `sample`: com streaming, conversa com várias mensagens, imagens e `signal`;
   - `downloads`.
3. Regras de dados no servidor, derivadas da tabela da seção 6.
4. Login no CMS por último, como você pediu. Até lá, o servidor usa um login de desenvolvimento que só funciona fora de produção.

Pendências antes do deploy:
- decisões D1 a D5;
- se o Radar fica global ou por unidade;
- criar `bairros/DF.json` e `bairros/TO.json` (vazios);
- exportar os dados do banco do Claude, se houver dados reais;
- testar o `/admin/health` do CMS.

## Decisões tomadas (17/11/2026)

| # | Decisão |
|---|---|
| D1 | **(a)** servidor intermediário em Node: login no CMS, cookie HttpOnly e arquivos só para quem entrou |
| D2 | proposta do guia: role 1 (franqueador) vê tudo; role 2 (master) só a unidade e a UF dele; role 3 (professor) bloqueado |
| D3 | **(b)** tabela de-para `unidades` (unit_id → UF, cidade, nome), editável pelo franqueador em `/unidades` e preenchida sozinha quando o CMS mandar `unit.state` (recomendação do guia, adotada por padrão) |
| D4 | **(a)** PostgreSQL no Railway, com documentos JSONB acessados pelo servidor |
| D5 | **(a)** IA ligada pela API da Anthropic no servidor, com limite diário por pessoa |
| D6 (17/11) | **Login pela API que está em produção no CMS** (`docs/GUIA_INTEGRACAO_FRONT_API.md`): o namespace `/admin` não existe em produção. Login v2 (`/v2/webbook/login`, assinado no servidor com `CMS_PASSWORD_SECRET`) ou v1 (`/v1/authentication`, servidor-a-servidor); validação por `/webbook/teacher/dashboard`. Papel e unidade vêm da tabela `acessos`, mantida pelo franqueador em `/acessos`; os franqueadores iniciais vêm de `GV_FRANQUEADORES` |
| D7 (17/11) | **Volta para a API `/admin` do CMS** (`docs/INTEGRACAO_API_FRONT.md`), publicada em `cmsdev.topenglish.com.br`: `CMS_API=admin` (padrão). Papel pelo `role_id` e unidade pelo `/admin/auth/me`; o estado vem por extenso e é convertido em sigla. O modo D6 continua disponível como `CMS_API=legado` até a API `/admin` chegar a `cms.topenglish.com.br` |
| D8 (18/11) | **Campanhas e brindes** (app "Campanhas de Vendas") entra no GeoVenda em Medir: franqueador cria campanhas e controla estoque; master lança alunos e entregas só da unidade dele; a campanha Black Friday 2026 foi migrada (`003_campanhas.sql`) |
| Extra | coleções do Radar (`pedidos`, `relatorios`, `dicas`, `palavras`, `horarios`, `monitor`, `proprios`) continuam compartilhadas entre todos os logados, como hoje |
