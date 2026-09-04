# Project TODO

- [x] Consolidar a central operacional dentro do repositório do bot
- [x] Criar persistência local de eventos sanitizados sem credenciais, sessões ou caminhos
- [x] Criar servidor HTTP local com timeline, health e atualização em tempo real
- [x] Migrar a interface verde para arquivos locais do mesmo projeto
- [x] Integrar inicialização da central e do bot em um único comando
- [x] Atualizar configuração e documentação para operação local
- [x] Criar testes locais para sanitização, eventos e endpoints
- [x] Validar sintaxe, testes, inicialização e fluxo de monitoramento
- [x] Enviar a consolidação para o repositório GitHub bot_whatsapp_novo

# Incidente de atualização local

- [x] Preservar os arquivos locais gerados antes de repetir o git pull
- [x] Confirmar que os arquivos sensíveis continuam fora do versionamento
- [x] Orientar a instalação e execução da versão atualizada

# Overhaul estrutural — fluxo simples

- [x] Mapear todos os estados atuais de inicialização, sync, conexão e recovery
- [x] Definir uma máquina de estados única e explícita para cada módulo
- [x] Remover dependência de flags globais ambíguas como sync inicial pendente
- [x] Separar captura ao vivo, importação histórica e recovery em fluxos independentes
- [x] Centralizar fila de mídia e deduplicação em um único responsável
- [x] Tornar o bot de tabelas independente do fluxo de mídia
- [x] Simplificar inicialização, encerramento e reconexão dos clientes WhatsApp
- [x] Atualizar a central para mostrar estados reais e mensagens operacionais claras
- [x] Criar testes de transição de estados e cenários de falha
- [x] Documentar a operação simplificada e validar o fluxo completo

# Recovery manual pela central

- [x] Criar endpoint local para acionar recovery com confirmação e lock
- [x] Publicar eventos de início, bloqueio, conclusão e falha do recovery manual
- [x] Adicionar botão verde com confirmação e feedback visual
- [x] Testar acionamento, execução concorrente e atualização do status

# Correção do recovery manual

- [x] Permitir que recovery manual execute mesmo sem desconexão registrada
- [x] Confirmar carregamento das obras e grupos configurados
- [x] Verificar histórico de cada grupo e processar mídias candidatas
- [x] Registrar contagem de grupos, mensagens, mídias baixadas e duplicadas
- [x] Testar recovery manual sem sessão real do WhatsApp
