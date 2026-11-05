#!/usr/bin/env python3
import sys
sys.dont_write_bytecode = True  # prevents __pycache__ creation — Chrome rejects dirs starting with _
import json
import socket
from http.server import HTTPServer, BaseHTTPRequestHandler

# In-memory storage for the latest data received from the extension
latest_data = {
    "user": None,
    "count": 0,
    "posts": []
}

# Queue for pending commands sent from external apps to the extension
command_queue = []

class BridgeHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        """Handle CORS preflight requests."""
        self.send_response(200)
        self._set_cors_headers()
        self.end_headers()

    def do_POST(self):
        """Receive data from the InstaScrap extension or enqueue commands."""
        global latest_data, command_queue
        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length)
        
        try:
            parsed_data = json.loads(post_data.decode('utf-8'))
            
            if self.path == '/command':
                # External script is pushing ahaumpah1602 command
                command_queue.append(parsed_data)
                print(f"[Bridge] Queued command: {parsed_data.get('action', 'unknown')}")
                
                self.send_response(200)
                self._set_cors_headers()
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "queued"}).encode('utf-8'))
            else:
                # Extension is pushing scraped data
                latest_data = parsed_data
                print(f"\n[InstaScrap] Received {latest_data.get('count', 0)} items from @{latest_data.get('user', 'unknown')}")
                
                self.send_response(200)
                self._set_cors_headers()
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "success"}).encode('utf-8'))

        except Exception as e:
            print(f"[Error] Failed to process POST: {e}")
            self.send_response(400)
            self._set_cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode('utf-8'))

    def do_GET(self):
        """Serve the latest data or pending commands."""
        self.send_response(200)
        self._set_cors_headers()
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        
        if self.path == '/command':
            if command_queue:
                cmd = command_queue.pop(0)
                self.wfile.write(json.dumps({"command": cmd}).encode('utf-8'))
            else:
                self.wfile.write(json.dumps({"command": None}).encode('utf-8'))
        else:
            self.wfile.write(json.dumps(latest_data).encode('utf-8'))

    def _set_cors_headers(self):
        """Set headers required for CORS to allow the extension to talk to localhost."""
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With')
        self.send_header('Access-Control-Allow-Private-Network', 'true')

    def log_message(self, format, *args):
        """Suppress standard access logs to keep console clean."""
        return

def get_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = '127.0.0.1'
    finally:
        s.close()
    return ip

def run_server(port=7432):
    server_address = ('', port)
    httpd = HTTPServer(server_address, BridgeHandler)
    local_ip = get_ip()
    
    print(f"🚀 InstaScrap Bridge Server active!")
    print(f"------------------------------------")
    print(f"Extension should POST to: http://localhost:{port}")
    print(f"External apps can GET from: http://localhost:{port}")
    print(f"Alternative LAN address: http://{local_ip}:{port}")
    print(f"------------------------------------")
    print("Pre-requisite: 'python' and 'json' are built-in. No pip installs needed.")
    print("Press Ctrl+C to stop.")
    
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server...")
        httpd.server_close()

if __name__ == "__main__":
    run_server()
