# Backend Node/Express + PostgreSQL

Este serviço substitui a API PHP/MySQL do formulário e mantém o contrato já usado pelo formulário e pelo consumidor Node local:

- `POST /api/evaluations.php` grava uma avaliação e responde `201`.
- `GET /api/evaluations.php?after_id=0&limit=100` exige `Authorization: Bearer <SYNC_API_TOKEN>` e retorna `{ items, nextAfterId }`.
- `GET` aceita o parâmetro opcional `cnpj`, incluindo CNPJ alfanumérico.
- Os nomes das colunas no PostgreSQL permanecem em português.

O Express também serve o formulário e os assets que estão na raiz do repositório. Assim, o navegador e a API ficam na mesma origem e o formulário pode continuar usando o caminho relativo `./api/evaluations.php`. Não publique a connection string nem o token no JavaScript do navegador.

## Executar localmente no Fedora

1. No Fedora KDE, instale Node.js e npm pelo terminal e confira se a versão é 20 ou superior:

   ```bash
   sudo dnf install nodejs npm
   node --version
   npm --version
   ```

   Se `node --version` mostrar uma versão anterior à 20, atualize o Node.js antes de continuar.
2. Entre nesta pasta e instale as dependências:

   ```bash
   cd render-api
   npm install
   cp .env.example .env
   ```

3. Edite `render-api/.env` com a connection string do PostgreSQL e um token aleatório com pelo menos 32 caracteres. Nunca faça commit desse arquivo.
4. No painel SQL do PostgreSQL, execute `render-api/sql/001_create_training_evaluations.sql` uma vez.
5. Inicie o servidor:

   ```bash
   npm run dev
   ```

   A página estará em `http://localhost:3000/` e a API em `http://localhost:3000/api/evaluations.php`.

Para conferir os tipos e os testes, use `npm run build` e `npm test`.

## Publicar gratuitamente no Render com PostgreSQL Neon

A camada gratuita é adequada para teste e baixo volume; ela não oferece garantia de disponibilidade contínua.

1. Crie um projeto PostgreSQL no Neon. Copie a connection string fornecida pelo painel, usando a conexão com TLS. No SQL Editor do Neon, execute `sql/001_create_training_evaluations.sql` desta pasta. Consulte o [guia de conexão Neon](https://neon.com/docs/connect/connect-from-any-app) e os [limites do Neon Free](https://neon.com/pricing): a cota atual inclui 1 GB de armazenamento por projeto e 100 CU-hours por mês, com suspensão automática após cinco minutos sem atividade.
2. No Render, crie um **Web Service** conectado a este repositório e selecione a branch que contém esta implementação.
3. Configure **Root Directory** como `render-api`, **Build Command** como `npm ci && npm run build`, **Start Command** como `npm start` e **Health Check Path** como `/api/health`.
4. Em Environment Variables do Render, configure `DATABASE_URL` com a connection string do Neon e `SYNC_API_TOKEN` com um segredo novo de pelo menos 32 caracteres. Não os adicione ao GitHub nem ao frontend.
5. O serviço serve o formulário que está um nível acima da pasta `render-api`. O formulário fica disponível na URL `onrender.com` e continua enviando para `./api/evaluations.php`. Teste o POST e o GET nessa mesma origem.

O Render pode suspender serviços web gratuitos após 15 minutos sem tráfego e leva em torno de um minuto para retomá-los. O plano gratuito também pode ter restrições mensais de instância. Consulte os [limites oficiais do Render Free](https://render.com/docs/free). O Neon Free suspende o compute após cinco minutos sem atividade; o primeiro acesso depois da suspensão pode demorar. Os limites podem mudar, e os planos gratuitos não oferecem garantia de disponibilidade contínua nem devem ser tratados como backup. Faça cópias de segurança dos dados importantes.

### Testar GET no Postman

- Método: `GET`
- URL: `https://SEU-SERVICO.onrender.com/api/evaluations.php`
- Params: `after_id=0`, `limit=100`; opcionalmente `cnpj=...`
- Authorization: **Bearer Token**; cole o mesmo valor configurado como `SYNC_API_TOKEN` no Render.

Não ponha o token nos parâmetros da URL. Sem token válido, a API responde `401`.

## Levar dados existentes do MySQL

Esta alteração cria um schema PostgreSQL novo; ela não migra automaticamente os registros do MySQL hospedado no InfinityFree. Antes de usar em produção, exporte e faça backup dos registros, importe-os para `training_evaluations` mantendo os campos equivalentes (`nome_empresa`, `cnpj`, `treinamento_no_horario`, `uso_sistema`, `avaliacao_geral`, `nota_indicacao`, `feedback`, `data_envio`) e preserve os IDs. Depois de importar IDs explícitos, ajuste a identidade executando `SELECT setval(pg_get_serial_sequence('training_evaluations', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM training_evaluations;`. Valide a contagem e uma amostra dos registros antes de apontar o formulário para o novo serviço.
