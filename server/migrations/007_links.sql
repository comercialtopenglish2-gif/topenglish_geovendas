-- Links rastreáveis: link curto /l/<codigo> que conta o clique e redireciona (WhatsApp ou site com UTM)
CREATE TABLE IF NOT EXISTS links (
  codigo      text PRIMARY KEY,
  espaco      text NOT NULL,
  criado_por  text NOT NULL,
  unidade     text NOT NULL DEFAULT '',
  nome        text NOT NULL,
  tipo        text NOT NULL,
  rede        text NOT NULL,
  numero      text NOT NULL DEFAULT '',
  mensagem    text NOT NULL DEFAULT '',
  url         text NOT NULL DEFAULT '',
  campanha    text NOT NULL DEFAULT '',
  destino     text NOT NULL,
  ativo       boolean NOT NULL DEFAULT true,
  criado      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS links_espaco ON links (espaco);
-- cada clique guarda só o horário (sem IP nem dado pessoal)
CREATE TABLE IF NOT EXISTS link_cliques (
  id      bigserial PRIMARY KEY,
  codigo  text NOT NULL REFERENCES links(codigo) ON DELETE CASCADE,
  em      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS link_cliques_codigo_em ON link_cliques (codigo, em);
