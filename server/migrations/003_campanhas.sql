-- Campanhas e brindes: traz a campanha que já existia no app "Campanhas de Vendas" (Claude), se ainda não existir
INSERT INTO docs(path, colecao, dados, versao, autor)
VALUES ('campanhas/black-friday-2026', 'campanhas',
  '{"nome":"Black Friday 2026","brinde":"Caixa Black","inicio":"2026-11-01","fim":"2026-11-30","regra":"Matrículas feitas de 1 a 30/11 e alunos de grupos abertos neste período: cada aluno ganha uma caixa. O aluno precisa estar cadastrado no sistema.","tiposValidos":["Matrícula","Grupo aberto"],"umPorAluno":true,"exigeSistema":true,"custoUnit":null,"meta":null,"aprendizados":"","criadoEm":1795032930000,"atualizadoEm":1795032930000}'::jsonb,
  nextval('docs_versao_seq'), 'migracao')
ON CONFLICT (path) DO NOTHING;
