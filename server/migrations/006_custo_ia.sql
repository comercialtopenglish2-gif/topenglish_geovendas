-- Custo de IA por chamada (limite mensal por pessoa, ciclo que renova no dia 5)
CREATE TABLE IF NOT EXISTS uso_ia_eventos (
  id          bigserial PRIMARY KEY,
  pessoa      text NOT NULL,
  em          timestamptz NOT NULL DEFAULT now(),
  funcao      text NOT NULL DEFAULT 'Outros',
  modelo      text NOT NULL DEFAULT '',
  tokens_in   int NOT NULL DEFAULT 0,
  tokens_out  int NOT NULL DEFAULT 0,
  custo_usd   numeric(12,6) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS uso_ia_eventos_pessoa_em ON uso_ia_eventos (pessoa, em);
