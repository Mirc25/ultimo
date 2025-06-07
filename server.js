const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const sanitizeHtml = require('sanitize-html');
require('dotenv').config(); 

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 1e8 
});

const PORT = process.env.PORT || 3000;

app.use(express.json()); 

// --- ESTRUCTURAS DE DATOS EN MEMORIA (para chat anónimo y global) ---
const onlineUsers = {}; 
const provinceChatHistory = {}; 
const privateChatHistory = {}; 

// --- CONFIGURACIÓN DE RATE LIMITING Y SILENCIAMIENTO (MUTE) ---
const MESSAGE_LIMITS = new Map(); // Guarda { socketId: [{ timestamp1, timestamp2, ... }] }
const MUTED_USERS = new Map();    // Guarda { socketId: unMuteTimestamp (Date.now() + duracion) }

const MAX_MESSAGES_PER_PERIOD = 2; // Máximo de mensajes permitidos
const PERIOD_SECONDS = 1; // En este período de tiempo
const MUTE_DURATION_MS = 1 * 60 * 1000; // Duración del silenciamiento: ¡1 MINUTO AHORA!

function checkRateLimit(socketId) {
    const now = Date.now();

    // 1. Verificar si el usuario está actualmente silenciado (muted)
    if (MUTED_USERS.has(socketId)) {
        const unMuteTime = MUTED_USERS.get(socketId);
        if (now < unMuteTime) { // Si aún está silenciado
            const remainingSeconds = Math.ceil((unMuteTime - now) / 1000);
            const remainingMinutes = Math.ceil(remainingSeconds / 60);
            console.warn(`🚫 [SERVER] Usuario ${socketId} silenciado. Tiempo restante: ${remainingSeconds}s.`);
            io.to(socketId).emit('status message', `ESTÁS GENERANDO SPAM. Debes esperar ${remainingMinutes} ${remainingMinutes === 1 ? 'minuto' : 'minutos'} para volver a escribir.`);
            return false; // Mensaje bloqueado
        } else {
            // Si el tiempo de silencio ha expirado, quitarlo de la lista de silenciados
            MUTED_USERS.delete(socketId);
            console.log(`✅ [SERVER] Usuario ${socketId} des-silenciado.`);
        }
    }

    // 2. Aplicar el rate limit si no está silenciado o si ya expiró el silencio
    let userTimestamps = MESSAGE_LIMITS.get(socketId) || [];

    console.log(`🔍 [RATE LIMIT] Check para ${socketId}. Antes de filtrar: ${userTimestamps.length} mensajes.`);

    const recentTimestamps = userTimestamps.filter(timestamp => (now - timestamp) < (PERIOD_SECONDS * 1000));
    
    console.log(`🔍 [RATE LIMIT] Para ${socketId}. Después de filtrar (últimos ${PERIOD_SECONDS}s): ${recentTimestamps.length} mensajes.`);
    console.log(`🔍 [RATE LIMIT] Para ${socketId}. Límite: ${MAX_MESSAGES_PER_PERIOD} mensajes.`);

    if (recentTimestamps.length >= MAX_MESSAGES_PER_PERIOD) {
        // Si excede el límite de mensajes, silenciar al usuario
        MUTED_USERS.set(socketId, now + MUTE_DURATION_MS);
        console.warn(`⚠️ [SERVER] Rate limit EXCEDIDO para ${socketId}. SILENCIADO por ${MUTE_DURATION_MS / 1000} segundos.`);
        io.to(socketId).emit('status message', `¡HAS EXCEDIDO EL LÍMITE DE MENSAJES! Has sido silenciado por ${MUTE_DURATION_MS / 1000 / 60} minuto.`); // Mensaje actualizado
        return false; // Mensaje bloqueado y usuario silenciado
    }

    recentTimestamps.push(now);
    MESSAGE_LIMITS.set(socketId, recentTimestamps.slice(-MAX_MESSAGES_PER_PERIOD));
    
    console.log(`✅ [RATE LIMIT] Mensaje PERMITIDO para ${socketId}. Mensajes en el período: ${recentTimestamps.length}`);
    return true; // Mensaje permitido
}

// Función auxiliar para obtener el historial de chat privado
function getPrivateChatId(user1, user2) {
    return [user1, user2].sort().join('-');
}

// Middleware para servir archivos estáticos (frontend de React)
app.use(express.static(path.join(__dirname, 'public')));

// Ruta principal para servir tu aplicación React
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// --- LÓGICA DE SOCKET.IO ---
io.on('connection', (socket) => {
    console.log(`🟢 [SERVER] Nuevo cliente conectado: ${socket.id}`);

    // Limpiar el rate limit y el estado de silencio al conectar para evitar bloqueos persistentes si el servidor se reinicia
    MESSAGE_LIMITS.delete(socket.id);
    MUTED_USERS.delete(socket.id);

    socket.on('register', ({ nickname, gender, province }) => {
        const sanitizedNickname = sanitizeHtml(nickname);
        const sanitizedGender = sanitizeHtml(gender);
        const sanitizedProvince = sanitizeHtml(province);

        console.log(`➡️ [SERVER] Intento de registro: ${sanitizedNickname} (${sanitizedGender}, ${sanitizedProvince}) desde ${socket.id}`);

        const existingUser = Object.values(onlineUsers).find(user => user.nickname.toLowerCase() === sanitizedNickname.toLowerCase());

        if (existingUser) { 
            console.log(`❌ [SERVER] Nickname '${sanitizedNickname}' ya en uso. Rechazando conexión para ${socket.id}`);
            socket.emit('nickname in use', `El nickname "${sanitizedNickname}" ya está en uso. Por favor, elige otro.`);
            socket.disconnect(true); 
            return;
        }

        onlineUsers[socket.id] = { 
            nickname: sanitizedNickname, 
            gender: sanitizedGender, 
            province: sanitizedProvince, 
            socketId: socket.id,
            lastSeen: new Date()
        };
        socket.join(sanitizedProvince); 

        console.log(`✅ [SERVER] Usuario registrado: ${onlineUsers[socket.id].nickname} (${onlineUsers[socket.id].gender}, ${onlineUsers[socket.id].province}) - Socket ID: ${socket.id}`);
        socket.emit('info accepted'); 

        io.emit('user list', Object.values(onlineUsers).map(u => ({
            nickname: u.nickname,
            gender: u.gender,
            province: u.province,
            socketId: u.socketId
        })));

        if (provinceChatHistory[onlineUsers[socket.id].province]) {
            socket.emit('province history', { 
                room: onlineUsers[socket.id].province, 
                history: provinceChatHistory[onlineUsers[socket.id].province] 
            });
        }
    });

    const getSenderData = (socketId) => {
        const user = onlineUsers[socketId];
        return {
            sender: user ? user.nickname : 'Desconocido',
            senderGender: user ? user.gender : 'other'
        };
    };

    socket.on('chat message', (data) => {
        if (!checkRateLimit(socket.id)) { 
            return; 
        }
        const { sender, senderGender } = getSenderData(socket.id); 
        const userProvince = onlineUsers[socket.id] ? onlineUsers[socket.id].province : 'unknown';

        const sanitizedText = sanitizeHtml(data.text);
        const message = {
            sender: sender,
            senderGender: senderGender, 
            text: sanitizedText,
            timestamp: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }),
            room: userProvince, 
            type: 'text'
        };

        if (!provinceChatHistory[userProvince]) {
            provinceChatHistory[userProvince] = [];
        }
        provinceChatHistory[userProvince].push(message);

        io.to(userProvince).emit('chat message', message);
        console.log(`💬 [SERVER] Mensaje de sala '${userProvince}' de ${sender}: ${sanitizedText}`);
    });

    socket.on('image message', (data) => {
        if (!checkRateLimit(socket.id)) { 
            return; 
        }
        const { sender, senderGender } = getSenderData(socket.id); 
        const userProvince = onlineUsers[socket.id] ? onlineUsers[socket.id].province : 'unknown';

        const message = {
            sender: sender,
            senderGender: senderGender,
            file: data.file, 
            timestamp: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }),
            room: userProvince,
            type: 'image'
        };

        if (!provinceChatHistory[userProvince]) {
            provinceChatHistory[userProvince] = [];
        }
        provinceChatHistory[userProvince].push(message);

        io.to(userProvince).emit('chat message', message); 
        console.log(`🖼️ [SERVER] Imagen de sala '${userProvince}' de ${sender} (${data.file.substring(0, 30)}...)`);
    });

    socket.on('private message', async ({ to, text }) => {
        if (!checkRateLimit(socket.id)) { 
            return; 
        }
        const senderData = getSenderData(socket.id); 
        const recipientUser = Object.values(onlineUsers).find(u => u.nickname === to);

        if (!senderData.sender || !recipientUser) {
            console.warn(`⚠️ [SERVER] Mensaje privado: remitente (${socket.id}) o destinatario (${to}) no encontrado.`);
            return;
        }

        const sanitizedText = sanitizeHtml(text);
        const message = {
            sender: senderData.sender,
            senderGender: senderData.senderGender, 
            text: sanitizedText,
            timestamp: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }),
            to: recipientUser.nickname, 
            type: 'text'
        };

        const privateChatId = getPrivateChatId(senderData.sender, recipientUser.nickname);
        if (!privateChatHistory[privateChatId]) {
            privateChatHistory[privateChatId] = [];
        }
        privateChatHistory[privateChatId].push(message);

        io.to(recipientUser.socketId).emit('private message', message);
        io.to(socket.id).emit('private message', message); 
        console.log(`🔒 [SERVER] Mensaje privado de ${senderData.sender} a ${recipientUser.nickname}: ${sanitizedText}`);
    });

    socket.on('private image message', async ({ to, file }) => {
        if (!checkRateLimit(socket.id)) { 
            return; 
        }
        const senderData = getSenderData(socket.id); 
        const recipientUser = Object.values(onlineUsers).find(u => u.nickname === to);

        if (!senderData.sender || !recipientUser) {
            console.warn(`⚠️ [SERVER] Imagen privada: remitente (${socket.id}) o destinatario (${to}) no encontrado.`);
            return;
        }

        const message = {
            sender: senderData.sender,
            senderGender: senderData.senderGender,
            file: file, 
            timestamp: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }),
            to: recipientUser.nickname,
            type: 'image'
        };

        const privateChatId = getPrivateChatId(senderData.sender, recipientUser.nickname);
        if (!privateChatHistory[privateChatId]) {
            privateChatHistory[privateChatId] = [];
        }
        privateChatHistory[privateChatId].push(message);

        io.to(recipientUser.socketId).emit('private message', message); 
        io.to(socket.id).emit('private message', message); 
        console.log(`🖼️🔒 [SERVER] Imagen privada de ${senderData.sender} a ${recipientUser.nickname} (${file.substring(0, 30)}...)`);
    });

    socket.on('disconnect', (reason) => {
        const disconnectedUser = onlineUsers[socket.id];
        if (disconnectedUser) {
            delete onlineUsers[socket.id];
            socket.leave(disconnectedUser.province); 
            console.log(`🔴 [SERVER] Usuario ${disconnectedUser.nickname} (${disconnectedUser.gender}) se ha desconectado. Razón: ${reason}`);

            io.emit('user list', Object.values(onlineUsers).map(u => ({
                nickname: u.nickname,
                gender: u.gender,
                province: u.province,
                socketId: u.socketId
            })));
        } else {
            console.log(`🔴 [SERVER] Cliente no registrado (${socket.id}) se ha desconectado. Razón: ${reason}`);
        }
        MESSAGE_LIMITS.delete(socket.id); 
        MUTED_USERS.delete(socket.id); 
    });

    socket.on('connect_error', (err) => {
        console.error(`❌ [SERVER] Error de conexión para ${socket.id}: ${err.message}`);
    });
});

server.listen(PORT, () => {
    console.log(`✅ [SERVER] Servidor de chat escuchando en http://localhost:${PORT}`);
    console.log(`✅ [SERVER] La aplicación React se servirá desde el directorio 'public'`);
});