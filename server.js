const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
// Permitir CORS desde cualquier origen para desarrollo
const io = socketIo(server, {
    cors: {
        origin: "*", // Permite cualquier origen durante el desarrollo
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 1e8 // Aumenta el límite de tamaño de mensaje a 100MB (para archivos grandes)
});

// Servir archivos estáticos desde la carpeta 'public'
app.use(express.static(path.join(__dirname, 'public')));

let users = []; // Array para almacenar usuarios conectados (id, username, gender)
let globalChatHistory = []; // Historial de mensajes globales

// Listener para la conexión de Socket.IO
io.on('connection', (socket) => {
    console.log('Usuario conectado:', socket.id);

    // Cuando un usuario se registra con un nickname y género
    socket.on('register', ({ username, gender }) => {
        // Verificar si el nickname ya está en uso (ignorando el propio usuario si se reconecta)
        const existingUser = users.find(u => u.username === username && u.id !== socket.id);
        if (existingUser) {
            socket.emit('nickname in use', `El nickname "${username}" ya está en uso.`);
            return;
        }

        const userIndex = users.findIndex(u => u.id === socket.id);
        if (userIndex !== -1) {
            users[userIndex] = { id: socket.id, username, gender };
        } else {
            users.push({ id: socket.id, username, gender });
        }

        io.emit('user list', users);
        io.emit('status message', `${username} se ha conectado.`);
        socket.emit('global history', globalChatHistory);
    });

    socket.on('request global history', () => {
        socket.emit('global history', globalChatHistory);
    });

    // Manejar mensajes de chat global
    socket.on('chat message', (msg) => {
        const senderUser = users.find(u => u.id === socket.id);
        if (senderUser) {
            const fullMessage = {
                username: senderUser.username,
                text: msg.text,
                gender: senderUser.gender,
                timestamp: msg.timestamp,
                type: msg.type || 'text', // Asegura el tipo de mensaje
                url: msg.url, // Para archivos/imágenes
                fileName: msg.fileName, // Para archivos
                senderSocketId: socket.id
            };
            globalChatHistory.push(fullMessage);
            io.emit('chat message', fullMessage);
        } else {
            console.warn(`Mensaje global recibido de socket no registrado: ${socket.id}`);
        }
    });

    // Manejar mensajes privados
    socket.on('private message', ({ to, message }) => {
        const fullMessage = message; // 'message' ya viene con todos los datos del cliente

        const recipientExists = users.some(u => u.id === to);
        if (recipientExists && to !== socket.id) {
            io.to(to).emit('private message', fullMessage);
            socket.emit('private message', fullMessage);
        } else if (to === socket.id) {
             console.warn(`Intento de enviar mensaje privado a sí mismo: ${socket.id}`);
        } else {
            console.warn(`Mensaje privado para destinatario no encontrado: ${to} de ${socket.id}`);
        }
    });

    // Cuando un usuario se desconecta
    socket.on('disconnect', () => {
        console.log('Usuario desconectado:', socket.id);
        const disconnectedUser = users.find(u => u.id === socket.id);
        users = users.filter(u => u.id !== socket.id);

        io.emit('user list', users);
        if (disconnectedUser) {
            io.emit('status message', `${disconnectedUser.username} se ha desconectado.`);
        }
    });
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
    console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
