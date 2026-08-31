# Review e overhaul do bot WhatsApp

## Objetivo

O projeto reúne três responsabilidades: captura de mídias de grupos de obras via Baileys, recuperação de histórico via `whatsapp-web.js` e atendimento de pedidos de tabelas com geração de PDF. O problema central identificado foi **concorrência sem coordenação**, não apenas falha isolada de um módulo.

## Diagnóstico

| Área | Problema encontrado | Impacto |
|---|---|---|
| Eventos Baileys | Cada lote de mensagens era processado inline e handlers assíncronos podiam se sobrepor | Ordem imprevisível entre captura de mídia e comandos de tabela |
| Recovery | Um segundo cliente WhatsApp era iniciado sem lock de processo | Duas sessões podiam consultar histórico e gravar o mesmo cache ao mesmo tempo |
| Cache/estado | `shared_state.json` e `.media_index.json` eram regravados diretamente | Risco de JSON truncado ou sobrescrito em queda/interrupção |
| Tabelas | O sincronizador do Notion era importado, mas não era chamado pelo fluxo real | `database.json` podia ficar desatualizado e o usuário receber tabela incompleta |
| Notion | Sincronizações simultâneas não eram impedidas | Consultas duplicadas e possível substituição concorrente do cache |
| Versionamento | Dados operacionais, caminhos locais, IDs de grupos e store de mensagens estavam rastreados | Exposição de informações internas e repositório muito pesado |
| Dependências | `pino` era usado diretamente, mas não estava declarado como dependência de primeiro nível | Instalações limpas poderiam falhar dependendo da árvore transitiva |

## Correções aplicadas

Foi criada a camada `runtime.js`, com leitura tolerante, escrita JSON atômica por arquivo temporário seguido de rename e lock exclusivo com recuperação de lock obsoleto. O estado compartilhado e os caches do fluxo Baileys/recovery agora usam essa camada.

O `index.js` passou a serializar o processamento das mensagens por uma fila de Promises. Assim, downloads, respostas do table bot e atualizações de estado não competem dentro do mesmo lote. Também foi evitada a criação repetida do timer de persistência e de timers de reconexão.

O recovery passou a adquirir `./.recovery.lock` antes de inicializar o cliente `whatsapp-web.js`. Se outra execução já estiver ativa, a nova execução encerra sem abrir uma segunda rotina concorrente. As gravações do cache do recovery também passaram a ser atômicas.

O table bot agora verifica a idade do cache antes de processar uma mensagem. Quando o cache está ausente ou com mais de 24 horas, ele dispara uma única sincronização do Notion; pedidos simultâneos aguardam a mesma Promise. Se o Notion estiver indisponível, o bot mantém o último cache local e informa o erro no log, evitando indisponibilidade total do atendimento.

O `package.json` agora declara scripts de operação (`start`, `recovery`, `sync`, `check`), declara `pino` explicitamente e o lockfile foi atualizado. O `.gitignore` passou a excluir configurações de obras, bancos locais, store, estado compartilhado, caches, locks e artefatos de PDF/JSON. Esses arquivos foram removidos do índice do Git, mas permanecem no diretório local para a operação atual.

## Fluxo recomendado

O processo principal deve ser iniciado apenas com `npm start`. O recovery não deve ser iniciado manualmente enquanto outra execução de recovery estiver ativa; o lock agora impede duplicação, mas a operação correta é deixar o processo principal controlar a decisão ou executar `npm run recovery` somente quando necessário. A sincronização manual pode ser feita com `npm run sync`.

Antes de instalar em uma máquina limpa, mantenha localmente os arquivos `obras.json`, `database_orgaos.json` e, se necessário, uma cópia válida de `database.json`. Configure `NOTION_API_KEY` e `NOTION_DATABASE_ID` no `.env`, nunca no Git. Os caminhos em `obras.json` precisam existir na máquina que executa o bot; os caminhos atualmente versionados eram caminhos absolutos de Windows e não são portáveis.

## Validação realizada

Foram executados `npm run check`, validação de sintaxe dos módulos, validação dos JSON existentes e um teste isolado de leitura/escrita atômica e exclusividade do lock. Não foi feita conexão real ao WhatsApp, download de mídia ou consulta ao Notion, porque isso exigiria as sessões autenticadas e o ambiente operacional do usuário.

## Riscos remanescentes e próximos passos

A recuperação ainda usa `whatsapp-web.js` como cliente separado porque essa é a estratégia existente do projeto. O lock evita dois recoveries simultâneos, mas a política operacional ideal é tornar o recovery um modo exclusivo: durante uma recuperação longa, o processo principal deve suspender captura/reconexão e só retomar depois do término. Isso exige uma decisão adicional sobre a janela aceitável de indisponibilidade.

Também recomendo, em uma segunda etapa, substituir arquivos JSON de estado por SQLite ou outro armazenamento transacional, criar testes com mensagens Baileys simuladas e adicionar métricas de fila, tempo de download, falhas de mídia e idade do cache do Notion. Essas medidas tornam a operação observável e permitem detectar degradação antes que o usuário perceba.
