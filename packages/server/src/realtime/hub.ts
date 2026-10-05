/**
 * Realtime fan-out: which sockets watch which game.
 *
 * Deliberately tiny and free of game logic. The hub only knows the
 * `gameId -> sockets` relation; the app subscribes on upgrade, unsubscribes on
 * close and calls {@link RealtimeHub.broadcast} after a mutation. That is the
 * multiplayer seam of the whole backend: every socket of a game sees the
 * updates caused by any other socket.
 */
import type { ServerWebSocket } from "bun";
import type { Logger } from "../logger";
import { serializeServerMessage } from "./protocol";
import type { ServerMessage } from "./protocol";

/** Data attached to an upgraded socket so handlers can find their game. */
export interface SocketData {
  readonly gameId: string;
}

/** The socket flavour this server hands out. */
export type GameSocket = ServerWebSocket<SocketData>;

/** Room registry used by the HTTP/WebSocket handlers. */
export interface RealtimeHub {
  /**
   * Adds a socket to a game's room, moving it out of any previous room.
   *
   * Called from the socket `open` handler, i.e. after a successful upgrade.
   */
  subscribe(gameId: string, socket: GameSocket): void;
  /** Removes a socket from its room; safe to call for unknown sockets. */
  unsubscribe(socket: GameSocket): void;
  /** The room a socket currently belongs to, or `undefined`. */
  gameIdOf(socket: GameSocket): string | undefined;
  /** Sends one frame to every open socket of a game; never throws. */
  broadcast(gameId: string, message: ServerMessage): void;
  /** Number of sockets currently subscribed to a game. */
  clientCount(gameId: string): number;
  /**
   * Terminates every socket and forgets all rooms.
   *
   * Call it *after* the listener stopped: Bun's `server.stop(true)` does not
   * resolve for sockets that were terminated server-side just before.
   */
  closeAll(): void;
}

/** Options of {@link createRealtimeHub}. */
export interface RealtimeHubOptions {
  /** Receives send failures; the hub stays silent without one. */
  readonly logger?: Logger;
}

/** WebSocket `readyState` value for an open connection. */
const SOCKET_OPEN = 1;

/** Creates an empty hub. */
export function createRealtimeHub(options: RealtimeHubOptions = {}): RealtimeHub {
  const socketsByGame = new Map<string, Set<GameSocket>>();
  // Reverse index: makes `unsubscribe` independent of `ws.data` and keeps
  // `gameIdOf` cheap. Weak so a dropped socket never leaks.
  const gameBySocket = new WeakMap<GameSocket, string>();
  const { logger } = options;

  const unsubscribe = (socket: GameSocket): void => {
    const gameId = gameBySocket.get(socket);
    if (gameId === undefined) return;
    gameBySocket.delete(socket);

    const sockets = socketsByGame.get(gameId);
    if (sockets === undefined) return;
    sockets.delete(socket);
    if (sockets.size === 0) socketsByGame.delete(gameId);
  };

  return {
    subscribe(gameId, socket) {
      unsubscribe(socket);
      let sockets = socketsByGame.get(gameId);
      if (sockets === undefined) {
        sockets = new Set();
        socketsByGame.set(gameId, sockets);
      }
      sockets.add(socket);
      gameBySocket.set(socket, gameId);
    },

    unsubscribe,

    gameIdOf(socket) {
      return gameBySocket.get(socket);
    },

    broadcast(gameId, message) {
      const sockets = socketsByGame.get(gameId);
      if (sockets === undefined || sockets.size === 0) return;

      // Serialise once: every subscriber gets the same frame.
      const frame = serializeServerMessage(message);
      for (const socket of [...sockets]) {
        // A socket may have closed while we iterated; skip and let `close`
        // (or this check) clean the room up.
        if (socket.readyState !== SOCKET_OPEN) {
          unsubscribe(socket);
          continue;
        }
        try {
          socket.send(frame);
        } catch (error) {
          logger?.warn("websocket send failed", { gameId, error });
          unsubscribe(socket);
        }
      }
    },

    clientCount(gameId) {
      return socketsByGame.get(gameId)?.size ?? 0;
    },

    closeAll() {
      for (const sockets of [...socketsByGame.values()]) {
        for (const socket of [...sockets]) {
          try {
            // `terminate` instead of a close handshake: a shutting-down server
            // must not wait for every client to answer a close frame.
            socket.terminate();
          } catch (error) {
            logger?.debug("websocket terminate failed", { error });
          }
        }
      }
      socketsByGame.clear();
    },
  };
}
