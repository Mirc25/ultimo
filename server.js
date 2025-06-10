const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
  cors: {
    origin: "https://mirc25.com", // Permitir conexiones desde tu app React (el frontend)
    methods: ["GET", "POST"]
  },
  // Mejorar la tolerancia a la red para móviles
  pingTimeout: 30000, // Tiempo de espera antes de considerar desconectado (default 20s)
  pingInterval: 5000 // Frecuencia de envío de pings (default 25s)
});

// El puerto del backend. Render.com lo asignará a process.env.PORT, localmente será 8000.
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());

// --- Gestión de usuarios online ---
// connectedUsers: Map<socket.id, { id, nickname, sex, province }>
const connectedUsers = new Map();
// nicknameToSocketId: Map<nickname, socket.id> - para saber qué nickname está en uso y por quién
const nicknameToSocketId = new Map();

io.on('connection', (socket) => {
  console.log(`Un usuario se ha conectado: ${socket.id}`);

  // 1. EL CLIENTE ENVIARÁ SU INFORMACIÓN EN ESTE EVENTO DESPUÉS DE CONECTARSE
  socket.on('user_info', (data) => {
    const { nickname, sex, province } = data;

    if (!nickname || !sex || !province) {
      console.log(`⚠️ Info de usuario incompleta de ${socket.id}. Desconectando.`);
      socket.emit('status message', 'Información de usuario incompleta. Por favor, reintenta.');
      socket.disconnect(true); // Desconecta la nueva conexión si la info es inválida
      return;
    }

    // --- Validación de Nickname en Uso ---
    if (nicknameToSocketId.has(nickname)) {
        const existingSocketId = nicknameToSocketId.get(nickname);
        if (existingSocketId !== socket.id) { // Nickname en uso por otra CONEXIÓN ACTIVA (otro socket.id)
            console.log(`❌ Nickname "${nickname}" ya en uso por otro ID: ${existingSocketId}. Nuevo intento de ${socket.id}.`);
            socket.emit('nickname in use', `El nickname "${nickname}" ya está en uso. Por favor, elige otro.`);
            socket.disconnect(true); // Desconecta la nueva conexión
            return;
        } else {
            // Es el mismo usuario reconectando con el mismo nickname y socket.id.
            // Esto puede pasar en algunas reconexiones donde el socket.id no cambia inmediatamente
            // o el cliente reenvía la info. Actualizamos el estado si es necesario.
            console.log(`🔄 Nickname "${nickname}" ya registrado para este socket ${socket.id}. Actualizando info.`);
            const currentUser = connectedUsers.get(socket.id);
            if (currentUser && (currentUser.sex !== sex || currentUser.province !== province)) {
                connectedUsers.set(socket.id, { id: socket.id, nickname, sex, province });
            }
            // No necesitamos re-emitir la lista ni la info accepted, ya que el estado ya está consistente
            return;
        }
    }

    // Si el nickname no estaba en uso o es una nueva conexión con un nickname único
    const user = { id: socket.id, nickname, sex, province };
    connectedUsers.set(socket.id, user);
    nicknameToSocketId.set(nickname, socket.id); // Registra el nickname y su socket.id actual

    console.log(`✅ Usuario ${nickname} (${socket.id}) conectado a la sala: ${province}`);
    socket.join(province); // Une al usuario a la sala de su provincia

    // Emitir la lista actualizada de usuarios a todos los clientes
    io.emit('user list', Array.from(connectedUsers.values()));
    socket.emit('info accepted', province); // Confirma al cliente que su info fue aceptada

    // Emitir mensaje de estado a la sala provincial (solo para la sala)
    io.to(province).emit('status message', `${nickname} se ha unido al canal.`);
  });


  // --- Eventos de Mensajes ---
  socket.on('chat message', (msg) => {
    const user = connectedUsers.get(socket.id);
    if (!user) {
        console.log(`⚠️ Mensaje de socket sin info de usuario (no registrado): ${socket.id}`);
        // Considerar enviar un mensaje de error al cliente o desconectarlo
        return;
    }
    const messageToSend = {
        sender: user.nickname,
        text: msg.text,
        timestamp: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }),
        room: user.province // Aseguramos que el mensaje va a la sala del usuario
    };
    console.log(`💬 Mensaje recibido de ${user.nickname} en ${user.province}: ${msg.text}`);
    io.to(user.province).emit('chat message', messageToSend);
  });

  socket.on('private message', (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user) {
        console.log(`⚠️ Mensaje privado de socket sin info de usuario (no registrado): ${socket.id}`);
        return;
    }
    const { to, msg } = data;
    const recipientSocketId = nicknameToSocketId.get(to); // Busca el socket.id del destinatario por su nickname

    if (recipientSocketId) {
        const privateMessage = {
            from: user.nickname,
            to: to,
            text: msg.text,
            timestamp: new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }),
        };
        console.log(`🔒 Mensaje privado de ${user.nickname} para ${to}`);
        // Enviar al destinatario
        io.to(recipientSocketId).emit('private message', privateMessage);
        // También enviar al remitente para que lo vea en su propia conversación
        io.to(socket.id).emit('private message', privateMessage);
    } else {
        console.log(`❌ Destinatario privado "${to}" no encontrado.`);
        socket.emit('status message', `El usuario "${to}" no está online o no fue encontrado.`);
    }
  });

  // --- Manejo de Desconexión ---
  socket.on('disconnect', (reason) => {
    console.log(`Un usuario se ha desconectado: ${socket.id}. Razón: ${reason}`);
    const user = connectedUsers.get(socket.id); // Obtiene la info del usuario desconectado

    if (user) {
        connectedUsers.delete(socket.id); // Elimina el socket.id del mapa de usuarios conectados

        // Comprueba si el nickname de este usuario todavía está asociado a otro socket.id
        // Si no hay ningún otro socket.id usando este nickname, lo eliminamos de nicknameToSocketId.
        let isNicknameStillInUseByAnotherSocket = false;
        for (let [sId, u] of connectedUsers) {
            if (u.nickname === user.nickname && sId !== socket.id) {
                isNicknameStillInUseByAnotherSocket = true;
                break;
            }
        }
        if (!isNicknameStillInUseByAnotherSocket) {
            nicknameToSocketId.delete(user.nickname); // Libera el nickname
            console.log(`✅ Nickname "${user.nickname}" liberado.`);
        }

        // Si el usuario estaba en una sala provincial, el socket.io-client lo manejará automáticamente
        // al salir de la sala. Aquí solo actualizamos la lista de usuarios.
        io.emit('user list', Array.from(connectedUsers.values()));
        io.emit('status message', `${user.nickname} se ha desconectado.`);
        console.log(`🟢 ${user.nickname} (${socket.id}) desconectado. Usuarios online: ${connectedUsers.size}`);
    } else {
        console.log(`🔴 Socket ${socket.id} desconectado, pero no se encontró información de usuario registrada.`);
    }
  });
});

// Ruta de prueba para el servidor
app.get('/', (req, res) => {
  res.send('Servidor de chat funcionando con Express y Socket.IO');
});

server.listen(PORT, () => {
  console.log(`SERVER: Servidor de chat escuchando en el puerto ${PORT}`);
});