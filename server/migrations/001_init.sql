-- GeoVenda · esquema inicial (aplicado automaticamente pelo servidor ao iniciar)
CREATE TABLE IF NOT EXISTS docs (
  path          text PRIMARY KEY,           -- caminho completo do documento (ex.: data/users/cms-10/fu-abc)
  colecao       text NOT NULL,              -- caminho da coleção-pai (ex.: data/users/cms-10)
  dados         jsonb NOT NULL,
  versao        bigint NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  autor         text
);
CREATE INDEX IF NOT EXISTS docs_colecao_idx ON docs (colecao);
CREATE SEQUENCE IF NOT EXISTS docs_versao_seq;

CREATE TABLE IF NOT EXISTS pessoas (
  id            text PRIMARY KEY,           -- "cms-<user_id>"
  nome          text,
  email         text,
  role_id       int,
  unit_id       int,
  ultimo_login  timestamptz
);

-- D3b: de-para unit_id -> UF/cidade/nome, editável pelo franqueador
CREATE TABLE IF NOT EXISTS unidades (
  unit_id       int PRIMARY KEY,
  nome          text,
  uf            char(2),
  cidade        text,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

-- uso da IA por pessoa e dia (limite D5a)
CREATE TABLE IF NOT EXISTS uso_ia (
  pessoa        text NOT NULL,
  dia           date NOT NULL,
  chamadas      int NOT NULL DEFAULT 0,
  tokens_in     bigint NOT NULL DEFAULT 0,
  tokens_out    bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (pessoa, dia)
);
