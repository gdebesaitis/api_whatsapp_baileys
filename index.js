import express from 'express';
import pkg from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());

const sessoes = new Map();

// 🔹 Função pra carregar sessões existentes na inicialização
async function carregarSessoesExistentes() {
    const authBaseDir = path.join(__dirname, 'auth_info');
    
    if (!fs.existsSync(authBaseDir)) {
        fs.mkdirSync(authBaseDir, { recursive: true });
        return;
    }

    const pastas = fs.readdirSync(authBaseDir).filter(item => {
        const itemPath = path.join(authBaseDir, item);
        return fs.statSync(itemPath).isDirectory();
    });

    console.log(`📂 Encontradas ${pastas.length} sessões salvas`);

    for (const nomeSessao of pastas) {
        try {
            console.log(`🔄 Carregando sessão: ${nomeSessao}`);
            await criarSessao(nomeSessao);
        } catch (error) {
            console.error(`❌ Erro ao carregar sessão ${nomeSessao}:`, error.message);
        }
    }
}

// 🔹 Função pra criar sessão
async function criarSessao(nomeSessao) {
    if (sessoes.has(nomeSessao)) {
        const sessaoExistente = sessoes.get(nomeSessao);
        if (sessaoExistente.ready) return sessaoExistente;
        console.log(`🔄 Recriando sessão existente: ${nomeSessao}`);
    }

    const authDir = path.join(__dirname, 'auth_info', nomeSessao);
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ['WhatsApp API', 'Chrome', '1.0.0'],
        defaultQueryTimeoutMs: 60000,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        shouldIgnoreJid: (jid) => false,
        retryRequestDelayMs: 250,
        maxMsgRetryCount: 3,
        connectTimeoutMs: 60000,
        qrTimeout: 60000,
        emitOwnEvents: false
    });

    const sessao = { 
        sock, 
        ready: false, 
        qrCode: null, 
        nome: nomeSessao, 
        user: null,
        tentativasReconexao: 0,
        maxTentativas: 3
    };
    sessoes.set(nomeSessao, sessao);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessao.qrCode = await QRCode.toDataURL(qr);
            sessao.ready = false;
            console.log(`📱 QR Code gerado para ${nomeSessao}`);
        }

        if (connection === 'open') {
            sessao.ready = true;
            sessao.qrCode = null;
            sessao.user = sock.user;
            sessao.tentativasReconexao = 0;
            console.log(`✅ ${nomeSessao} conectado`);
        }

        if (connection === 'close') {
            sessao.ready = false;
            sessao.user = null;
            
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`⚠️ ${nomeSessao} desconectou (${statusCode})`);

            if (statusCode === DisconnectReason.loggedOut) {
                console.log(`🚪 ${nomeSessao} fez logout`);
                sessoes.delete(nomeSessao);
                if (fs.existsSync(authDir)) {
                    fs.rmSync(authDir, { recursive: true, force: true });
                }
            } else if ([515, 428, 503, 502, 500].includes(statusCode)) {
                // Códigos que indicam erro temporário do servidor
                if (sessao.tentativasReconexao < sessao.maxTentativas) {
                    sessao.tentativasReconexao++;
                    console.log(`🔄 Tentativa ${sessao.tentativasReconexao}/${sessao.maxTentativas} de reconexão para ${nomeSessao}`);
                    setTimeout(() => {
                        criarSessao(nomeSessao);
                    }, 5000 * sessao.tentativasReconexao); // Delay progressivo
                } else {
                    console.log(`❌ Máximo de tentativas excedido para ${nomeSessao}`);
                    sessao.qrCode = null;
                }
            }
        }
    });

    // Verifica se já está conectado após carregar credenciais
    if (state.creds?.registered) {
        setTimeout(() => {
            if (sock.user) {
                sessao.ready = true;
                sessao.user = sock.user;
                sessao.qrCode = null;
                console.log(`✅ ${nomeSessao} restaurado da sessão salva`);
            }
        }, 2000);
    }

    return sessao;
}

// 🔹 Rota para pegar QR Code
app.get('/qrcode/:sessao', async (req, res) => {
    const nomeSessao = req.params.sessao;
    let sessao = sessoes.get(nomeSessao);
    
    if (!sessao) {
        sessao = await criarSessao(nomeSessao);
    }

    if (sessao.ready && sessao.user) {
        return res.json({ 
            status: 'connected', 
            ready: true, 
            message: 'Sessão conectada',
            user: sessao.user.id 
        });
    }
    
    if (sessao.qrCode) {
        return res.json({ 
            status: 'qr_ready', 
            qr: sessao.qrCode, 
            ready: false 
        });
    }
    
    return res.status(202).json({ 
        status: 'waiting', 
        ready: false, 
        message: 'Aguardando QR Code' 
    });
});

// 🔹 Rota para status
app.get('/status/:sessao', (req, res) => {
    const nomeSessao = req.params.sessao;
    const sessao = sessoes.get(nomeSessao);
    
    res.json({
        existe: !!sessao,
        conectado: sessao?.ready || false,
        aguardandoQR: !!sessao?.qrCode && !sessao?.ready,
        usuario: sessao?.user?.id || null,
        tentativasReconexao: sessao?.tentativasReconexao || 0,
        maxTentativas: sessao?.maxTentativas || 3
    });
});

// 🔹 Verificar se sessão está pronta
function verificarSessao(nomeSessao) {
    const sessao = sessoes.get(nomeSessao);
    if (!sessao) return { erro: 'Sessão não encontrada' };
    if (!sessao.ready) return { erro: 'Sessão não conectada' };
    if (!sessao.sock) return { erro: 'Socket não disponível' };
    return { sessao, sock: sessao.sock };
}

// 🔹 Enviar mensagem
app.post('/mensagem/:sessao', async (req, res) => {
    const { numero, mensagem } = req.body;
    const nomeSessao = req.params.sessao;
    
    if (!numero || !mensagem) {
        return res.status(400).json({ error: 'Número e mensagem são obrigatórios' });
    }

    const { erro, sock } = verificarSessao(nomeSessao);
    if (erro) return res.status(503).json({ error: erro });

    const jid = numero.includes('@s.whatsapp.net') ? numero : `${numero}@s.whatsapp.net`;
    
    try {
        const result = await sock.sendMessage(jid, { text: mensagem });
        
        res.json({ 
            status: 'Mensagem enviada', 
            numero: jid, 
            mensagem,
            messageId: result.key.id
        });
    } catch (err) {
        console.error(`❌ Erro ao enviar mensagem:`, err.message);
        res.status(500).json({ 
            error: 'Erro ao enviar mensagem', 
            detalhes: err.message
        });
    }
});

// 🔹 Enviar arquivos
app.post('/arquivo/:sessao', async (req, res) => {
    const { numero, arquivos = [], legenda } = req.body;
    const nomeSessao = req.params.sessao;
    
    if (!numero) {
        return res.status(400).json({ error: 'Número é obrigatório' });
    }

    const { erro, sock } = verificarSessao(nomeSessao);
    if (erro) return res.status(503).json({ error: erro });

    const jid = numero.includes('@s.whatsapp.net') ? numero : `${numero}@s.whatsapp.net`;
    const enviados = [];

    try {
        for (const arquivo of arquivos) {
            if (!fs.existsSync(arquivo)) continue;
            
            const buffer = fs.readFileSync(arquivo);
            const fileName = path.basename(arquivo);
            
            await sock.sendMessage(jid, { 
                document: buffer, 
                fileName: fileName,
                mimetype: 'application/octet-stream'
            });
            
            enviados.push(fileName);
        }
        
        if (legenda) {
            await sock.sendMessage(jid, { text: legenda });
        }

        res.json({ 
            status: 'Arquivos enviados', 
            enviados,
            total: enviados.length
        });
        
    } catch (err) {
        console.error(`❌ Erro ao enviar arquivos:`, err.message);
        res.status(500).json({ 
            error: 'Erro ao enviar arquivos', 
            detalhes: err.message
        });
    }
});

// 🔹 Forçar reconexão de uma sessão existente
app.post('/reconectar/:sessao', async (req, res) => {
    const nomeSessao = req.params.sessao;
    const authDir = path.join(__dirname, 'auth_info', nomeSessao);
    
    if (!fs.existsSync(authDir)) {
        return res.status(404).json({ error: 'Pasta de autenticação não encontrada' });
    }
    
    try {
        // Remove sessão existente se houver
        if (sessoes.has(nomeSessao)) {
            const sessaoAntiga = sessoes.get(nomeSessao);
            if (sessaoAntiga.sock) {
                try {
                    sessaoAntiga.sock.end();
                } catch (e) {}
            }
            sessoes.delete(nomeSessao);
        }
        
        // Cria nova sessão
        const novaSessao = await criarSessao(nomeSessao);
        
        res.json({ 
            status: 'Sessão sendo reconectada',
            nome: nomeSessao,
            ready: novaSessao.ready
        });
    } catch (err) {
        res.status(500).json({ 
            error: 'Erro ao reconectar', 
            detalhes: err.message 
        });
    }
});

// 🔹 Desconectar sessão
app.post('/desconectar/:sessao', async (req, res) => {
    const nomeSessao = req.params.sessao;
    const sessao = sessoes.get(nomeSessao);
    
    if (!sessao) {
        return res.status(404).json({ error: 'Sessão não encontrada' });
    }
    
    try {
        if (sessao.sock) {
            await sessao.sock.logout();
        }
        sessoes.delete(nomeSessao);
        
        const authDir = path.join(__dirname, 'auth_info', nomeSessao);
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
        }
        
        res.json({ status: 'Sessão desconectada e removida' });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao desconectar', detalhes: err.message });
    }
});

// 🔹 Listar todas as sessões
app.get('/sessoes', (req, res) => {
    const listaSessoes = Array.from(sessoes.entries()).map(([nome, sessao]) => ({
        nome,
        conectado: sessao.ready,
        usuario: sessao.user?.id || null,
        aguardandoQR: !!sessao.qrCode
    }));
    
    res.json({ sessoes: listaSessoes, total: listaSessoes.length });
});

app.get('/contatos/:sessao', async (req, res) => {
    const nomeSessao = req.params.sessao;
    const { erro, sock } = verificarSessao(nomeSessao);

    if (erro) return res.status(503).json({ error: erro });

    try {
        // fetchContacts() retorna todos os contatos conhecidos da sessão
        const contatos = await sock.fetchContacts();

        // Formata para simplificar
        const listaContatos = Object.values(contatos).map(c => ({
            id: c.id,           // ex: 555199999999@s.whatsapp.net
            nome: c.name || c.notify || null,
            numerico: c.id.split('@')[0] // só o número
        }));

        res.json({ total: listaContatos.length, contatos: listaContatos });
    } catch (err) {
        console.error(`❌ Erro ao buscar contatos:`, err.message);
        res.status(500).json({ error: 'Erro ao buscar contatos', detalhes: err.message });
    }
});

// 🔹 Inicia servidor
const PORT = process.env.PORT || 9000;

// Carrega sessões existentes ao iniciar
carregarSessoesExistentes().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 API rodando na porta ${PORT}`);
    });
});