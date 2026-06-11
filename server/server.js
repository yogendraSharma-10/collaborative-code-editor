```javascript
/**
 * server/server.js
 *
 * Main entry point for the Collaborative Code Editor's Node.js backend.
 * This file sets up an Express server to handle API requests and a Socket.IO server
 * for real-time collaboration. It also serves the static React frontend.
 */

// --- IMPORTS ---
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const axios = require('axios');
const initializeSocketHandlers = require('./documentHandler');

// --- CONFIGURATION ---
dotenv.config();

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 5001;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Microservice URLs from environment variables, demonstrating interconnected architecture
const VERSIONING_SERVICE_URL = process.env.VERSIONING_SERVICE_URL || 'http://localhost:8000';
const BLOG_API_URL = process.env.BLOG_API_URL; // e.g., http://localhost:3001/api
const RECIPE_API_URL = process.env.RECIPE_API_URL; // e.g., http://localhost:4001/api

// CORS configuration to allow requests from the frontend
const corsOptions = {
  origin: [
    process.env.CLIENT_URL || 'http://localhost:3000',
    // In a real-world scenario, you might add origins for other internal services
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true,
};

// Socket.IO server setup with CORS
const io = new Server(server, {
  cors: corsOptions,
  // Increase ping timeout for more stable connections over flaky networks
  pingTimeout: 60000,
});

// --- MIDDLEWARE ---
app.use(cors(corsOptions));
app.use(express.json()); // For parsing application/json

// Serve static files from the React app's production build directory
app.use(express.static(path.join(__dirname, '..', 'build')));

// Simple request logger middleware
app.use((req, res, next) => {
  if (NODE_ENV !== 'test') {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  }
  next();
});


// --- API ROUTES ---

/**
 * @route GET /health
 * @description Health check endpoint to verify the server is running.
 * Useful for load balancers and uptime monitoring.
 */
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Collaborative Code Editor server is healthy.',
    timestamp: new Date().toISOString(),
  });
});

// --- Versioning Service Proxy Routes ---
// These routes act as a gateway to the Python-based versioning microservice,
// abstracting its location from the frontend client.

/**
 * @route POST /api/v1/documents/:id/commit
 * @description Proxies a commit request to the Python versioning service.
 * @param {string} id - The ID of the document.
 * @body {string} content - The full content of the document to be committed.
 * @body {string} message - The commit message.
 * @body {string} author - The author of the commit.
 */
app.post('/api/v1/documents/:id/commit', async (req, res) => {
  const { id } = req.params;
  const { content, message, author } = req.body;

  if (!content || !message || !author) {
    return res.status(400).json({ error: 'Missing required fields: content, message, author' });
  }

  try {
    const response = await axios.post(`${VERSIONING_SERVICE_URL}/commit`, {
      document_id: id,
      content,
      message,
      author,
    });
    res.status(response.status).json(response.data);
  } catch (error) {
    console.error(`Error proxying commit to versioning service for doc ${id}:`, error.message);
    const status = error.response ? error.response.status : 502; // 502 Bad Gateway
    const data = error.response ? error.response.data : { error: 'Failed to communicate with versioning service.' };
    res.status(status).json(data);
  }
});

/**
 * @route GET /api/v1/documents/:id/history
 * @description Proxies a request to get commit history from the Python versioning service.
 * @param {string} id - The ID of the document.
 */
app.get('/api/v1/documents/:id/history', async (req, res) => {
    const { id } = req.params;
    try {
        const response = await axios.get(`${VERSIONING_SERVICE_URL}/history/${id}`);
        res.status(response.status).json(response.data);
    } catch (error) {
        console.error(`Error fetching history from versioning service for doc ${id}:`, error.message);
        const status = error.response ? error.response.status : 502;
        const data = error.response ? error.response.data : { error: 'Failed to communicate with versioning service.' };
        res.status(status).json(data);
    }
});


// --- Cross-Service Communication Example ---

/**
 * @route GET /api/v1/external/blog-posts
 * @description Example endpoint demonstrating communication with another microservice (Blog Platform).
 *              This could be used to embed or reference content from the blog within the editor.
 */
app.get('/api/v1/external/blog-posts', async (req, res) => {
    if (!BLOG_API_URL) {
        return res.status(501).json({
            error: 'Blog service integration is not configured.',
            message: 'BLOG_API_URL environment variable is not set.'
        });
    }
    try {
        // Example: Fetch the 5 most recent posts
        const response = await axios.get(`${BLOG_API_URL}/posts?limit=5`);
        res.status(200).json(response.data);
    } catch (error) {
        console.error('Error fetching data from Blog Platform service:', error.message);
        res.status(502).json({ error: 'Failed to communicate with the Blog service.' });
    }
});


// --- SOCKET.IO REAL-TIME LOGIC ---
// Delegate all socket connection handling to the documentHandler module for separation of concerns.
initializeSocketHandlers(io);


// --- SERVE REACT APP ---
// For any other GET request not handled by the API routes above, serve the React app's entry point.
// This is crucial for client-side routing (e.g., React Router) to work correctly on refresh.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'build', 'index.html'));
});


// --- ERROR HANDLING ---
// A simple catch-all error handler middleware.
app.use((err, req, res, next) => {
  console.error('Unhandled application error:', err.stack);
  res.status(500).send('Something broke!');
});


// --- SERVER STARTUP ---
server.listen(PORT, () => {
  console.log(`🚀 Server is running in ${NODE_ENV} mode on http://localhost:${PORT}`);
  console.log(`🔌 WebSocket server is ready and listening for connections.`);
});


// --- GRACEFUL SHUTDOWN ---
const gracefulShutdown = (signal) => {
  console.log(`\n${signal} received. Initiating graceful shutdown...`);
  server.close(() => {
    console.log('✅ HTTP server closed.');
    io.close(() => {
        console.log('🔌 WebSocket connections closed.');
        // Add any other cleanup here (e.g., database connections)
        process.exit(0);
    });
  });
};

// Listen for termination signals
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
```