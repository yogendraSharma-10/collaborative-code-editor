```javascript
/**
 * @file server/documentHandler.js
 * @description Handles all WebSocket logic for real-time document collaboration.
 * This includes managing document state, user connections, and broadcasting changes.
 * It also interfaces with the versioning service to persist document snapshots.
 */

const axios = require('axios');

// In-memory store for active documents.
// In a production environment, this would be replaced by a more robust, distributed
// solution like Redis to handle state across multiple server instances and provide persistence.
const documents = {};

// Environment variables
const VERSIONING_SERVICE_URL = process.env.VERSIONING_SERVICE_URL || 'http://localhost:5001';
const AUTOSAVE_INTERVAL = parseInt(process.env.AUTOSAVE_INTERVAL, 10) || 300000; // 5 minutes

// Constants for socket events to avoid magic strings and ensure consistency.
const EVENTS = {
  CONNECTION: 'connection',
  DISCONNECT: 'disconnect',
  JOIN_DOCUMENT: 'join-document',
  LOAD_DOCUMENT: 'load-document',
  SEND_CHANGES: 'send-changes',
  RECEIVE_CHANGES: 'receive-changes',
  SAVE_DOCUMENT: 'save-document',
  DOCUMENT_SAVED: 'document-saved',
  DOCUMENT_SAVE_ERROR: 'document-save-error',
  USER_JOINED: 'user-joined',
  USER_LEFT: 'user-left',
};

/**
 * Persists the current state of a document to the versioning service.
 * @param {string} documentId - The ID of the document to save.
 * @param {string} content - The full content of the document.
 * @returns {Promise<object>} The response from the versioning service.
 */
async function saveDocumentVersion(documentId, content) {
  try {
    console.log(`[Versioning] Attempting to save version for document: ${documentId}`);
    const response = await axios.post(`${VERSIONING_SERVICE_URL}/api/v1/versions`, {
      documentId,
      content,
      // This metadata could be used to link documents across services,
      // e.g., linking this collaborative document to a specific blog post
      // from the 'Full-Stack Blog Platform' or a recipe from the 'Recipe & Meal Planner'.
      metadata: {
        source: 'Collaborative Code Editor',
        timestamp: new Date().toISOString(),
      },
    });
    console.log(`[Versioning] Successfully saved version for document: ${documentId}. Version: ${response.data.version}`);
    return response.data;
  } catch (error) {
    console.error(`[Versioning] Error saving document ${documentId}:`, error.response ? error.response.data : error.message);
    // In a real app, you might have more sophisticated error handling,
    // like retries with exponential backoff or a dead-letter queue.
    throw new Error('Failed to save document version.');
  }
}

/**
 * Initializes and attaches socket event handlers for document collaboration.
 * @param {import('socket.io').Server} io - The Socket.IO server instance.
 */
function documentHandler(io) {
  io.on(EVENTS.CONNECTION, (socket) => {
    console.log(`[Socket.IO] User connected: ${socket.id}`);

    // Store the document ID associated with this socket connection
    let currentDocumentId = null;

    // Handler for when a client wants to join a document room
    socket.on(EVENTS.JOIN_DOCUMENT, async ({ documentId, user }) => {
      console.log(`[Socket.IO] User ${user?.id || socket.id} joining document: ${documentId}`);
      currentDocumentId = documentId;

      // Join the socket room for this document to receive broadcasts
      socket.join(documentId);

      // If the document is not in memory, initialize it.
      // In a real app, you'd fetch the latest version from a database
      // or the versioning service here.
      if (!documents[documentId]) {
        console.log(`[Document] Initializing document ${documentId} in memory.`);
        documents[documentId] = {
          id: documentId,
          content: `// Welcome to your collaborative document: ${documentId}\n// This could be a code file, a blog post, or a recipe!`,
          users: new Map(), // Using a Map to store user info against socket.id
        };
      }

      // Add the user to the list of active users for this document
      documents[documentId].users.set(socket.id, user || { id: socket.id, name: 'Anonymous' });

      // Send the current document content to the joining user
      socket.emit(EVENTS.LOAD_DOCUMENT, documents[documentId].content);

      // Notify other users in the room that a new user has joined
      socket.to(documentId).emit(EVENTS.USER_JOINED, {
        user: documents[documentId].users.get(socket.id),
        activeUsers: Array.from(documents[documentId].users.values()),
      });

      console.log(`[Document] Active users in ${documentId}:`, Array.from(documents[documentId].users.values()).map(u => u.name));
    });

    // Handler for receiving changes from a client
    socket.on(EVENTS.SEND_CHANGES, ({ documentId, delta }) => {
      // For this example, we assume 'delta' is the new full content.
      // A more advanced implementation would use operational transforms (OT)
      // or conflict-free replicated data types (CRDTs) to merge changes efficiently.
      if (documents[documentId]) {
        documents[documentId].content = delta;
      }

      // Broadcast the changes to all other clients in the room
      socket.to(documentId).emit(EVENTS.RECEIVE_CHANGES, delta);
    });

    // Handler for explicit save requests from the client
    socket.on(EVENTS.SAVE_DOCUMENT, async ({ documentId }) => {
      if (!documents[documentId]) {
        socket.emit(EVENTS.DOCUMENT_SAVE_ERROR, { message: 'Document not found on server.' });
        return;
      }

      try {
        const savedVersion = await saveDocumentVersion(documentId, documents[documentId].content);
        // Notify the entire room that the document was successfully saved
        io.to(documentId).emit(EVENTS.DOCUMENT_SAVED, {
          version: savedVersion.version,
          timestamp: savedVersion.timestamp,
        });
      } catch (error) {
        // Notify the requesting client of the save error
        socket.emit(EVENTS.DOCUMENT_SAVE_ERROR, { message: error.message });
      }
    });

    // Handler for when a client disconnects
    socket.on(EVENTS.DISCONNECT, () => {
      console.log(`[Socket.IO] User disconnected: ${socket.id}`);
      if (currentDocumentId && documents[currentDocumentId]) {
        const doc = documents[currentDocumentId];
        const leavingUser = doc.users.get(socket.id);
        doc.users.delete(socket.id);

        console.log(`[Document] User ${leavingUser?.name || socket.id} left document: ${currentDocumentId}`);

        // Notify remaining users
        io.to(currentDocumentId).emit(EVENTS.USER_LEFT, {
          user: leavingUser,
          activeUsers: Array.from(doc.users.values()),
        });

        // If no users are left in the document, we can clean it up from memory
        // and perform a final save to ensure the latest state is persisted.
        if (doc.users.size === 0) {
          console.log(`[Document] No users left in ${currentDocumentId}. Performing final save and cleanup.`);
          saveDocumentVersion(currentDocumentId, doc.content)
            .catch(err => console.error(`[Document] Final save for ${currentDocumentId} failed:`, err.message));
          delete documents[currentDocumentId];
        }
      }
    });
  });

  // Set up an interval for auto-saving all active documents
  setInterval(() => {
    console.log('[Autosave] Triggering periodic save for all active documents.');
    for (const documentId in documents) {
      if (Object.prototype.hasOwnProperty.call(documents, documentId)) {
        const doc = documents[documentId];
        // Only save if there are active users to prevent saving abandoned/empty docs.
        if (doc.users.size > 0 && doc.content) {
          saveDocumentVersion(documentId, doc.content)
            .catch(err => console.error(`[Autosave] Failed for document ${documentId}:`, err.message));
        }
      }
    }
  }, AUTOSAVE_INTERVAL);

  console.log('[DocumentHandler] Initialized and listening for socket connections.');
}

module.exports = documentHandler;
```