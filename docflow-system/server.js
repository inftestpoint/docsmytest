const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { body, validationResult } = require('express-validator');
const fs = require('fs');

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

// Настройка multer для загрузки файлов
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}-${file.originalname}`);
  }
});
const upload = multer({ storage });

// Секретный ключ для JWT
const JWT_SECRET = 'your-secret-key-change-in-production';

// Хранилище данных (в памяти)
const documents = [];
const messages = [];
const users = new Map();
const registeredUsers = []; // База зарегистрированных пользователей

// Middleware для проверки аутентификации
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Неверный токен' });
  }
};

// API для регистрации и авторизации
app.post('/api/auth/register', [
  body('username').notEmpty().withMessage('Имя пользователя обязательно'),
  body('password').isLength({ min: 6 }).withMessage('Пароль должен быть не менее 6 символов')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  
  const { username, password } = req.body;
  
  // Проверка существования пользователя
  if (registeredUsers.find(u => u.username === username)) {
    return res.status(400).json({ error: 'Пользователь уже существует' });
  }
  
  const hashedPassword = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(),
    username,
    password: hashedPassword,
    createdAt: new Date().toISOString()
  };
  
  registeredUsers.push(user);
  res.json({ message: 'Пользователь успешно зарегистрирован', userId: user.id });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  
  const user = registeredUsers.find(u => u.username === username);
  if (!user) {
    return res.status(401).json({ error: 'Неверное имя пользователя или пароль' });
  }
  
  const isValid = await bcrypt.compare(password, user.password);
  if (!isValid) {
    return res.status(401).json({ error: 'Неверное имя пользователя или пароль' });
  }
  
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, user: { id: user.id, username: user.username } });
});

// API для документов
app.get('/api/documents', (req, res) => {
  res.json(documents);
});

app.post('/api/documents', authMiddleware, upload.single('file'), (req, res) => {
  const { title, content, author, type } = req.body;
  const document = {
    id: uuidv4(),
    title,
    content,
    author,
    type: type || 'general',
    createdAt: new Date().toISOString(),
    status: 'active',
    createdBy: req.user.id,
    file: req.file ? {
      filename: req.file.filename,
      originalname: req.file.originalname,
      path: req.file.path,
      size: req.file.size
    } : null
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

app.put('/api/documents/:id', authMiddleware, (req, res) => {
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

app.delete('/api/documents/:id', authMiddleware, (req, res) => {
  const docIndex = documents.findIndex(d => d.id === req.params.id);
  if (docIndex === -1) {
    return res.status(404).json({ error: 'Document not found' });
  }
  
  const deletedDoc = documents.splice(docIndex, 1)[0];
  io.emit('document-deleted', { id: req.params.id });
  res.json({ message: 'Document deleted', document: deletedDoc });
});

// Загрузка файлов
app.get('/api/files/:filename', (req, res) => {
  const filePath = path.join(__dirname, 'uploads', req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Файл не найден' });
  }
  res.sendFile(filePath);
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
