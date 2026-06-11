```python
# versioning_service/main.py

import os
import uuid
import difflib
from datetime import datetime, timezone
from functools import wraps
from flask import Flask, request, jsonify

# --- App Initialization ---
app = Flask(__name__)

# --- Configuration ---
# In a real production environment, use a more robust configuration management system.
# For this example, we'll use environment variables.
PORT = os.environ.get("VERSIONING_SERVICE_PORT", 5002)
HOST = os.environ.get("HOST", "0.0.0.0")
# Secret key for securing inter-service communication
INTER_SERVICE_API_KEY = os.environ.get("INTER_SERVICE_API_KEY")

# --- In-Memory Data Store ---
# NOTE: This is for demonstration purposes only. In a production environment,
# you would use a persistent database like PostgreSQL, MongoDB, or a dedicated
# version control system backend like Git.
documents_versions = {}
# Example structure:
# {
#   "doc-id-123": [
#     {
#       "version_id": "uuid-v1",
#       "timestamp": "2023-10-27T10:00:00Z",
#       "author": "user1",
#       "message": "Initial commit",
#       "content": "Initial content of the document."
#     },
#     ...
#   ]
# }


# --- Decorators for Authentication/Authorization ---

def require_api_key(f):
    """
    Decorator to protect routes with an API key.
    Ensures that requests are coming from a trusted internal service.
    """
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not INTER_SERVICE_API_KEY:
            # If no key is set in the environment, bypass for development
            return f(*args, **kwargs)
        
        api_key = request.headers.get('X-API-Key')
        if api_key and api_key == INTER_SERVICE_API_KEY:
            return f(*args, **kwargs)
        else:
            return jsonify({"error": "Unauthorized: Invalid or missing API key"}), 401
    return decorated_function


# --- Helper Functions ---

def find_version(doc_id, version_id):
    """Finds a specific version of a document."""
    if doc_id not in documents_versions:
        return None
    for version in documents_versions[doc_id]:
        if version["version_id"] == version_id:
            return version
    return None

# --- API Routes ---

@app.route("/health", methods=["GET"])
def health_check():
    """
    Health check endpoint to verify the service is running.
    Also indicates its awareness of other services in the ecosystem.
    """
    return jsonify({
        "status": "ok",
        "service": "Versioning Service",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "interconnected_services": [
            "collaborative-editor-server",
            "full-stack-blog-platform",
            "recipe-meal-planner"
        ]
    }), 200

@app.route("/commit", methods=["POST"])
@require_api_key
def create_commit():
    """
    Creates a new version (commit) for a document.
    Expects JSON body: { "doc_id", "content", "author", "message" }
    """
    data = request.get_json()
    if not data or not all(k in data for k in ["doc_id", "content", "author", "message"]):
        return jsonify({"error": "Missing required fields: doc_id, content, author, message"}), 400

    doc_id = data["doc_id"]
    
    new_version = {
        "version_id": str(uuid.uuid4()),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "author": data["author"],
        "message": data["message"],
        "content": data["content"]
    }

    if doc_id not in documents_versions:
        documents_versions[doc_id] = []
    
    documents_versions[doc_id].append(new_version)
    
    # Return only the metadata of the new version, not the full content
    response_data = new_version.copy()
    del response_data["content"]

    return jsonify(response_data), 201

@app.route("/history/<string:doc_id>", methods=["GET"])
@require_api_key
def get_history(doc_id):
    """
    Retrieves the version history for a specific document.
    Returns a list of commit metadata (without the full content).
    """
    if doc_id not in documents_versions:
        return jsonify({"error": f"Document with id '{doc_id}' not found"}), 404

    # Create a history list without the 'content' field to keep the payload small
    history_metadata = [
        {k: v for k, v in version.items() if k != 'content'}
        for version in documents_versions[doc_id]
    ]
    
    # Return history in reverse chronological order (newest first)
    return jsonify(sorted(history_metadata, key=lambda x: x['timestamp'], reverse=True)), 200

@app.route("/version/<string:doc_id>/<string:version_id>", methods=["GET"])
@require_api_key
def get_version(doc_id, version_id):
    """
    Retrieves the full content of a specific version of a document.
    """
    version = find_version(doc_id, version_id)
    if not version:
        return jsonify({"error": f"Version '{version_id}' for document '{doc_id}' not found"}), 404
    
    return jsonify(version), 200

@app.route("/diff/<string:doc_id>", methods=["GET"])
@require_api_key
def get_diff(doc_id):
    """
    Computes and returns a unified diff between two versions of a document.
    Uses query parameters: `from_version` and `to_version`.
    """
    from_version_id = request.args.get('from')
    to_version_id = request.args.get('to')

    if not from_version_id or not to_version_id:
        return jsonify({"error": "Missing 'from' and 'to' query parameters for version IDs"}), 400

    from_version = find_version(doc_id, from_version_id)
    to_version = find_version(doc_id, to_version_id)

    if not from_version:
        return jsonify({"error": f"Source version '{from_version_id}' not found"}), 404
    if not to_version:
        return jsonify({"error": f"Target version '{to_version_id}' not found"}), 404

    from_content = from_version['content'].splitlines(keepends=True)
    to_content = to_version['content'].splitlines(keepends=True)

    diff = difflib.unified_diff(
        from_content,
        to_content,
        fromfile=f"version: {from_version_id}",
        tofile=f"version: {to_version_id}",
        lineterm='',
    )

    diff_str = "".join(diff)

    return jsonify({
        "doc_id": doc_id,
        "from_version": from_version_id,
        "to_version": to_version_id,
        "diff": diff_str
    }), 200


# --- Main Execution ---

if __name__ == "__main__":
    # The 'debug=True' is suitable for development.
    # In production, this script should be run by a production-grade
    # WSGI server like Gunicorn or uWSGI.
    print(f"--- Starting Versioning Service on http://{HOST}:{PORT} ---")
    if not INTER_SERVICE_API_KEY:
        print("WARNING: INTER_SERVICE_API_KEY is not set. API endpoints are not secured.")
    app.run(host=HOST, port=int(PORT), debug=True)
```