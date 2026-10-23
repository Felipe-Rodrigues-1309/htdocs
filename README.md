# Avaliação pós-treinamento — F5 Automação Comercial

O repositório contém o formulário compilado na raiz e uma nova implementação do backend em `render-api/` com Node.js, Express e PostgreSQL. O backend serve a página e os assets do formulário e conserva o endpoint `POST/GET /api/evaluations.php` para não exigir alteração no JavaScript publicado.

Para preparar banco, executar localmente ou publicar no Render com PostgreSQL Neon, siga [render-api/README.md](render-api/README.md). Execute [render-api/sql/001_create_training_evaluations.sql](render-api/sql/001_create_training_evaluations.sql) uma vez no PostgreSQL antes de testar gravações.

Não coloque `.env`, `DATABASE_URL`, token de sincronização ou arquivos `config.local.php` no Git. Configure `DATABASE_URL` e `SYNC_API_TOKEN` no painel de variáveis secretas do provedor.
