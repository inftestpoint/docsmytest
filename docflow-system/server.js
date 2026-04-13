const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Хранилище данных (в памяти)
const documents = [];
const messages = [];
const users = new Map();

// API для документов
app.get('/api/documents', (req, res) => {
  res.json(documents);
});

app.post('/api/documents', (req, res) => {
  const { title, content, author, type } = req.body;
  const document = {
    id: uuidv4(),
    title,
    content,
    author,
    type: type || 'general',
    createdAt: new Date().toISOString(),
    status: 'active'
  };
  documents.push(document);
  io.emit('document-created', document);
  res.json(document);
});

app.get('/api/documents/:id', (req, res) => {
  const doc = documents.find(d => d.id === req.params.id);
  if (!doc) {
    return res.status(404).json({ error: 'Document not found' });
  }
  res.json(doc);
});

app.put('/api/documents/:id', (req, res) => {
  const docIndex = documents.findIndex(d => d.id === req.params.id);
  if (docIndex === -1) {
    return res.status(404).json({ error: 'Document not found' });
  }
  
  const { title, content, status } = req.body;
  if (title) documents[docIndex].title = title;
  if (content) documents[docIndex].content = content;
  if (status) documents[docIndex].status = status;
  
  documents[docIndex].updatedAt = new Date().toISOString();
  io.emit('document-updated', documents[docIndex]);
  res.json(documents[docIndex]);
});

app.delete('/api/documents/:id', (req, res) => {
  const docIndex = documents.findIndex(d => d.id === req.params.id);
  if (docIndex === -1) {
    return res.status(404).json({ error: 'Document not found' });
  }
  
  const deletedDoc = documents.splice(docIndex, 1)[0];
  io.emit('document-deleted', { id: req.params.id });
  res.json({ message: 'Document deleted', document: deletedDoc });
});

// API для сообщений чата
app.get('/api/messages', (req, res) => {
  res.json(messages.slice(-50)); // Последние 50 сообщений
});

// Socket.IO для чата
io.on('connection', (socket) => {
  console.log('Пользователь подключился:', socket.id);
  
  socket.on('join', (userData) => {
    users.set(socket.id, userData);
    socket.broadcast.emit('user-joined', userData);
    socket.emit('current-users', Array.from(users.values()));
  });
  
  socket.on('chat-message', (messageData) => {
    const user = users.get(socket.id);
    const message = {
      id: uuidv4(),
      text: messageData.text,
      author: user ? user.name : 'Аноним',
      userId: socket.id,
      timestamp: new Date().toISOString()
    };
    messages.push(message);
    io.emit('chat-message', message);
  });
  
  socket.on('typing', () => {
    const user = users.get(socket.id);
    socket.broadcast.emit('user-typing', user ? user.name : 'Аноним');
  });
  
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    users.delete(socket.id);
    if (user) {
      io.emit('user-left', user);
    }
    console.log('Пользователь отключился:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер документооборота запущен на порту ${PORT}`);
  console.log(`Откройте в браузере: http://localhost:${PORT}`);
});
