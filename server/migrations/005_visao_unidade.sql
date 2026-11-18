-- Campanhas e brindes: o franqueador escolhe entrar como Unidade (a unidade da conta dele no CMS) ou como Franqueadora (com código)
ALTER TABLE sessoes ADD COLUMN IF NOT EXISTS camp_unidade boolean NOT NULL DEFAULT false;
