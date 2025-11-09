import { io, Socket } from 'socket.io-client';

const SOCKET_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';

class WebSocketClient {
  private socket: Socket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;

  connect() {
    if (this.socket?.connected) {
      return this.socket;
    }

    this.socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: this.maxReconnectAttempts,
      reconnectionDelay: this.reconnectDelay,
    });

    this.socket.on('connect', () => {
      console.log('WebSocket connected');
      this.reconnectAttempts = 0;
    });

    this.socket.on('disconnect', () => {
      console.log('WebSocket disconnected');
    });

    this.socket.on('connect_error', (error) => {
      console.error('WebSocket connection error:', error);
      this.reconnectAttempts++;
    });

    return this.socket;
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  joinRoom(projectId: string) {
    if (this.socket) {
      this.socket.emit('join', projectId);
      console.log(`Joined room: ${projectId}`);
    }
  }

  leaveRoom(projectId: string) {
    if (this.socket) {
      this.socket.emit('leave', projectId);
      console.log(`Left room: ${projectId}`);
    }
  }

  subscribeToProject(projectId: string) {
    this.connect();
    this.joinRoom(projectId);
  }

  unsubscribeFromProject(projectId: string) {
    this.leaveRoom(projectId);
  }

  on(event: string, callback: (data: any) => void): () => void {
    if (this.socket) {
      this.socket.on(event, callback);

      // Return unsubscribe function
      return () => {
        if (this.socket) {
          this.socket.off(event, callback);
        }
      };
    }

    // Return no-op function if socket is not available
    return () => {};
  }

  off(event: string, callback?: (data: any) => void) {
    if (this.socket) {
      if (callback) {
        this.socket.off(event, callback);
      } else {
        this.socket.off(event);
      }
    }
  }

  emit(event: string, data?: any) {
    if (this.socket) {
      this.socket.emit(event, data);
    }
  }

  isConnected(): boolean {
    return this.socket?.connected || false;
  }
}

// Export singleton instance
export const websocket = new WebSocketClient();

// Export types
export type { Socket };
