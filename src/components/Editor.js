```javascript
import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import CodeMirror from 'codemirror';
import 'codemirror/lib/codemirror.css';
import 'codemirror/theme/material-darker.css';
import 'codemirror/mode/javascript/javascript';
import 'codemirror/mode/python/python';
import 'codemirror/mode/xml/xml';
import 'codemirror/mode/css/css';
import 'codemirror/mode/jsx/jsx';
import 'codemirror/addon/edit/closetag';
import 'codemirror/addon/edit/closebrackets';

// Define supported languages and their corresponding CodeMirror modes
const supportedLanguages = {
  javascript: 'javascript',
  python: 'python',
  html: 'xml',
  css: 'css',
  jsx: 'jsx',
};

/**
 * The main collaborative editor component.
 * It uses CodeMirror for the text editor and Socket.IO for real-time collaboration.
 * @returns {JSX.Element} The Editor component.
 */
const Editor = () => {
  const { documentId } = useParams();
  const [socket, setSocket] = useState(null);
  const [editor, setEditor] = useState(null);
  const [language, setLanguage] = useState('javascript');
  const [users, setUsers] = useState([]);
  const [versionStatus, setVersionStatus] = useState('');
  const editorRef = useRef(null);
  const isRemoteChange = useRef(false); // Flag to prevent echoing changes

  // Effect for initializing the CodeMirror editor
  useEffect(() => {
    if (editorRef.current) {
      const cmInstance = CodeMirror.fromTextArea(editorRef.current, {
        lineNumbers: true,
        theme: 'material-darker',
        mode: language,
        autoCloseTags: true,
        autoCloseBrackets: true,
      });
      setEditor(cmInstance);

      // Cleanup on component unmount
      return () => {
        cmInstance.toTextArea();
      };
    }
  }, []); // Runs only once on mount

  // Effect for handling socket connection and events
  useEffect(() => {
    const serverUrl = process.env.REACT_APP_SERVER_URL || 'http://localhost:3001';
    const s = io(serverUrl);
    setSocket(s);

    s.on('connect', () => {
      console.log('Connected to server with socket ID:', s.id);
      // Join the document room upon connection
      s.emit('join-document', documentId);
    });

    s.on('load-document', (data) => {
      if (editor && data) {
        isRemoteChange.current = true;
        editor.setValue(data.content || '');
        setLanguage(data.language || 'javascript');
        isRemoteChange.current = false;
      }
    });

    s.on('receive-changes', (delta) => {
      if (editor) {
        isRemoteChange.current = true;
        const cursor = editor.getCursor();
        editor.replaceRange(delta.text, delta.from, delta.to);
        // Try to restore cursor position if it wasn't the user who made the change
        // This is a simplified cursor management approach
        if (cursor.line < delta.from.line || (cursor.line === delta.from.line && cursor.ch <= delta.from.ch)) {
            editor.setCursor(cursor);
        }
        isRemoteChange.current = false;
      }
    });

    s.on('update-user-list', (userList) => {
      setUsers(userList);
    });

    s.on('language-changed', (newLanguage) => {
      setLanguage(newLanguage);
    });

    s.on('disconnect', () => {
      console.log('Disconnected from server');
    });

    // Cleanup on component unmount
    return () => {
      s.disconnect();
    };
  }, [documentId, editor]);

  // Effect for handling local editor changes
  useEffect(() => {
    if (!editor || !socket) return;

    const handleChange = (instance, changes) => {
      if (isRemoteChange.current) {
        return;
      }
      // 'origin' helps differentiate user input from programmatic changes
      if (changes.origin !== 'setValue') {
        socket.emit('send-changes', changes);
      }
    };

    editor.on('change', handleChange);

    return () => {
      editor.off('change', handleChange);
    };
  }, [editor, socket]);

  // Effect to update CodeMirror's mode when language changes
  useEffect(() => {
    if (editor) {
      editor.setOption('mode', supportedLanguages[language] || 'javascript');
    }
  }, [language, editor]);

  /**
   * Handles language selection change.
   * @param {React.ChangeEvent<HTMLSelectElement>} e - The change event.
   */
  const handleLanguageChange = (e) => {
    const newLanguage = e.target.value;
    setLanguage(newLanguage);
    if (socket) {
      socket.emit('change-language', { documentId, language: newLanguage });
    }
  };

  /**
   * Handles saving a new version of the document by calling the versioning service.
   */
  const handleSaveVersion = async () => {
    if (!editor) return;
    setVersionStatus('Saving...');
    try {
      const versioningServiceUrl = process.env.REACT_APP_VERSIONING_SERVICE_URL || 'http://localhost:5000';
      const response = await fetch(`${versioningServiceUrl}/api/v1/versions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          document_id: documentId,
          content: editor.getValue(),
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      setVersionStatus(`Version saved: ${result.version_id.substring(0, 8)}`);
    } catch (error) {
      console.error('Failed to save version:', error);
      setVersionStatus('Error saving version.');
    } finally {
      setTimeout(() => setVersionStatus(''), 3000);
    }
  };

  /**
   * Simulates importing a code snippet from the interconnected Blog Platform.
   */
  const handleImportFromBlog = () => {
    // In a real application, this would open a modal to fetch posts from the blog API
    const blogApiUrl = process.env.REACT_APP_BLOG_API_URL || 'http://localhost:8000/api';
    console.log(`Simulating import from Blog API at ${blogApiUrl}`);
    alert('Feature to import snippet from Blog Platform is a work in progress!');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <header style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '8px 16px',
        backgroundColor: '#1c1c1c',
        borderBottom: '1px solid #333'
      }}>
        <div className="controls">
          <label htmlFor="language-select" style={{ marginRight: '10px', color: '#ccc' }}>Language:</label>
          <select id="language-select" value={language} onChange={handleLanguageChange} style={{ padding: '5px' }}>
            {Object.keys(supportedLanguages).map(lang => (
              <option key={lang} value={lang}>{lang.charAt(0).toUpperCase() + lang.slice(1)}</option>
            ))}
          </select>
          <button onClick={handleSaveVersion} style={{ marginLeft: '20px', padding: '5px 10px' }}>
            Save Version
          </button>
          {versionStatus && <span style={{ marginLeft: '10px', color: '#00bfa5' }}>{versionStatus}</span>}
          {/* Cross-project context feature */}
          <button onClick={handleImportFromBlog} title="Import from Blog Platform" style={{ marginLeft: '10px', padding: '5px 10px' }}>
            Import Snippet
          </button>
        </div>
        <div className="user-list" style={{ color: '#ccc' }}>
          Active Users: {users.length}
          <div style={{ display: 'flex', marginLeft: '10px' }}>
            {users.map(user => (
              <div key={user.id} title={user.id} style={{
                width: '24px',
                height: '24px',
                borderRadius: '50%',
                backgroundColor: user.color,
                marginLeft: '-8px',
                border: '2px solid #1c1c1c'
              }}></div>
            ))}
          </div>
        </div>
      </header>
      <div style={{ flexGrow: 1, height: 'calc(100% - 50px)' }}>
        <textarea ref={editorRef} />
      </div>
    </div>
  );
};

export default Editor;
```