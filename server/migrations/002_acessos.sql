-- GeoVenda · login pela API de produção do CMS (docs/GUIA_INTEGRACAO_FRONT_API.md)
-- A API de produção não informa papel nem unidade: o GeoVenda guarda quem pode entrar e em qual unidade.

-- unidades passam a ter id próprio (sequência), editadas pelo franqueador em /acessos
CREATE SEQUENCE IF NOT EXISTS unidades_id_seq;
SELECT setval('unidades_id_seq', GREATEST((SELECT coalesce(max(unit_id), 0) FROM unidades), 1000));
ALTER TABLE unidades ALTER COLUMN unit_id SET DEFAULT nextval('unidades_id_seq');

-- quem pode entrar no GeoVenda (e-mail do CMS) e com qual papel
CREATE TABLE IF NOT EXISTS acessos (
  email      text PRIMARY KEY,                       -- sempre em minúsculas
  papel      text NOT NULL CHECK (papel IN ('franqueador', 'master')),
  unit_id    int REFERENCES unidades(unit_id),       -- obrigatório para master
  ativo      boolean NOT NULL DEFAULT true,
  criado_em  timestamptz NOT NULL DEFAULT now(),
  criado_por text
);

-- sessões do GeoVenda: o cookie guarda só um id aleatório; o token do CMS fica aqui, no servidor
CREATE TABLE IF NOT EXISTS sessoes (
  id_hash    text PRIMARY KEY,                       -- sha256 do id do cookie
  pessoa_id  text NOT NULL,
  email      text NOT NULL,
  token      text NOT NULL,                          -- JWT do CMS (nunca vai para o navegador)
  expira_em  timestamptz NOT NULL,
  criado_em  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessoes_expira_idx ON sessoes (expira_em);

-- dados extras da pessoa vindos do CMS
ALTER TABLE pessoas ADD COLUMN IF NOT EXISTS perfil_cms text;
CREATE UNIQUE INDEX IF NOT EXISTS pessoas_email_idx ON pessoas (lower(email));
