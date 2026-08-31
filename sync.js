const { Client } = require('@notionhq/client');
const fs = require('fs');
const dotenv = require('dotenv');
const path = require('path');
const { writeJsonAtomic, acquireProcessLock } = require('./runtime');
const { emitEvent } = require('./monitorClient');

// Carregar variáveis de ambiente
dotenv.config();

// Inicializar cliente Notion
const notion = new Client({
    auth: process.env.NOTION_API_KEY,
    notionVersion: '2026-03-11'
});

async function sincronizarNotion() {
    console.log('🔄 Iniciando sincronização com Notion...');
    emitEvent({ module: 'notion', severity: 'info', eventType: 'sync_started', message: 'Sincronização do Notion iniciada' });
    let releaseLock = null;
    
    try {
        const databaseId = process.env.NOTION_DATABASE_ID;
        if (!process.env.NOTION_API_KEY || !databaseId) {
            throw new Error('NOTION_API_KEY e NOTION_DATABASE_ID são obrigatórios para sincronizar.');
        }
        releaseLock = acquireProcessLock(path.resolve('./.notion-sync.lock'), 30 * 60 * 1000);
        if (!releaseLock) {
            console.log('ℹ️ Sincronização do Notion já está em andamento.');
            return carregarCacheLocal();
        }
        
        // Descobrir data_source_id
        const databaseInfo = await notion.databases.retrieve({ database_id: databaseId });
        const dataSourceId = databaseInfo.data_sources[0].id;
        
        let allResults = [];
        let hasMore = true;
        let cursor = undefined; // Mudar de null para undefined
        
        let pagina = 1;
        
        while (hasMore) {
            console.log(`📥 Página ${pagina} baixada...`);
            
            // Preparar parâmetros da query
            const queryParams = {
                data_source_id: dataSourceId,
                page_size: 100 // Máximo permitido pela API
            };
            
            // Adicionar cursor apenas se tiver valor válido
            if (cursor) {
                queryParams.start_cursor = cursor;
            }
            
            const response = await notion.dataSources.query(queryParams);
            
            // Concatenar resultados
            allResults = allResults.concat(response.results);
            console.log(`📊 ${allResults.length} licitações acumuladas até agora...`);
            
            // Atualizar variáveis para próxima iteração
            hasMore = response.has_more;
            cursor = response.next_cursor; // Pode ser undefined na última página
            
            pagina++;
            
            // Pequeno delay para não sobrecarregar a API
            if (hasMore) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        
        // Salvar em arquivo JSON
        const databaseFile = {
            timestamp: new Date().toISOString(),
            total_items: allResults.length,
            data: allResults // Array gigante com todas as licitações
        };
        
        writeJsonAtomic(path.resolve('./database.json'), databaseFile);
        releaseLock();
        releaseLock = null;
        
        console.log(`✅ Sincronização concluída! ${allResults.length} licitações salvas em database.json`);
        emitEvent({ module: 'notion', severity: 'info', eventType: 'sync_completed', message: 'Sincronização do Notion concluída', details: { totalItems: allResults.length, pages: pagina - 1 } });
        console.log(`🕐 Última atualização: ${new Date().toLocaleString('pt-BR')}`);
        console.log(`📄 Processadas ${pagina - 1} páginas no total`);
        
        return allResults;
        
    } catch (error) {
        if (releaseLock) releaseLock();
        emitEvent({ module: 'notion', severity: 'error', eventType: 'sync_error', message: 'Falha na sincronização do Notion', details: { error: error.message } });
        console.error('❌ Erro na sincronização:', error);
        if (error.code === 'validation_error') {
            console.error('💡 Dica: Verifique se as variáveis de ambiente NOTION_API_KEY e NOTION_DATABASE_ID estão corretas');
        }
        throw error;
    }
}

function carregarCacheLocal() {
    try {
        return JSON.parse(fs.readFileSync('./database.json', 'utf8')).data || [];
    } catch (_) {
        return [];
    }
}

// Função para verificar se precisa sincronizar
function precisaSincronizar() {
    if (!fs.existsSync('database.json')) {
        console.log('📁 database.json não existe. Precisa sincronizar.');
        return true;
    }
    
    try {
        const stats = fs.statSync('database.json');
        const lastModified = new Date(stats.mtime);
        const agora = new Date();
        const horasDesdeModificacao = (agora - lastModified) / (1000 * 60 * 60);
        
        console.log(`🕐 database.json modificado há ${horasDesdeModificacao.toFixed(1)} horas`);
        
        if (horasDesdeModificacao > 24) {
            console.log('⏰ database.json está velho (mais de 24h). Precisa sincronizar.');
            return true;
        }
        
        console.log('✅ database.json está atualizado.');
        return false;
        
    } catch (error) {
        console.error('❌ Erro ao verificar database.json:', error);
        return true;
    }
}

// Executar sincronização se chamado diretamente
if (require.main === module) {
    (async () => {
        try {
            await sincronizarNotion();
            process.exit(0);
        } catch (error) {
            console.error('❌ Falha na sincronização:', error);
            process.exit(1);
        }
    })();
}

module.exports = { sincronizarNotion, precisaSincronizar };
