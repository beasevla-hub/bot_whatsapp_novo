# Operação local: bot + central

A central operacional agora vive dentro deste mesmo repositório e não depende do Manus em runtime. O comando `npm start` inicia o processo principal do Baileys e o dashboard local em `http://127.0.0.1:8787`.

## Instalação

```powershell
npm install
Copy-Item .env.example .env
notepad .env
```

Mantenha no `.env` as credenciais já utilizadas pelo bot. Para a central local, o único parâmetro opcional é:

```env
DASHBOARD_PORT=8787
MONITOR_LOG_PATH=./monitor_events.jsonl
```

Não preencha `MONITOR_URL` para a operação local. O publicador grava eventos sanitizados em `monitor_events.jsonl`, que está no `.gitignore`.

## Execução

```powershell
npm run check
npm start
```

Abra `http://127.0.0.1:8787` no navegador. O painel atualiza a cada dois segundos e apresenta conexão, mídias salvas, filas, tabela/PDF, recovery, Notion e falhas recentes.

O arquivo `monitor_events.jsonl` contém somente eventos sanitizados. Credenciais, sessões, QR Codes e caminhos reais não devem ser adicionados manualmente aos eventos.

## Comandos auxiliares

```powershell
npm run dashboard  # sobe somente a central
npm run recovery   # executa recovery manual
npm run sync       # sincroniza o cache do Notion
```

Para um processo contínuo em Windows, use o Agendador de Tarefas ou PM2. A central é um servidor HTTP local criado pelo mesmo processo do bot; portanto, não é necessário iniciar outro projeto ou serviço.
