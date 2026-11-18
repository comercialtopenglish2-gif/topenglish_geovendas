-- Campanhas e brindes: o franqueador só vê o resultado de todas as unidades depois de digitar o código da rede
ALTER TABLE sessoes ADD COLUMN IF NOT EXISTS rede_camp boolean NOT NULL DEFAULT false;
