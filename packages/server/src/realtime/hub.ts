/**
 * Realtime fan-out: which sockets watch which channel.
 *
 * Deliberately tiny and free of game logic. The hub only knows the
 * `channel -> sockets` relation; the app subscribes on upgrade, unsubscribes on
 * close and calls {@link RealtimeHub.broadcast} after a mutation. That is the
 * multiplayer seam of the whole backend: every socket of a channel sees the
 * updates caused by any other socket.
 *
 * A channel is a plain string. Game sockets use the game id, room sockets use
 * `room:<roomId>`: a room subscribes to both, so it can relay presence to its
 * players and game updates to the same sockets without a second connection.
 */
import type { ServerWebSocket } from "bun";
import type { Logger } from "../logger";
import { serializeServerMessage } from "./protocol";
import type { ServerMessage } from "./protocol";

/** Data attached to an upgraded socket so handlers can find their channel. */
export interface SocketData {
  /** Fan-out channel: a game id, or `room:<roomId>` for a room socket. */
  readonly channel: string;
  /** Room the socket belongs to, when it is a room socket. */
  readonly roomId?: string;
  /** Player the socket speaks for, when the client identified itself. */
  readonly playerId?: string;
}

/** The socket flavour this server hands out. */
export type ClientSocket = ServerWebSocket<SocketData>;

/** Backwards-compatible alias for the previous single-purpose name. */
export type GameSocket = ClientSocket;

/** Prefix that keeps room channels in their own namespace. */
export const ROOM_CHANNEL_PREFIX = "room:";

/** Channel name of a room's sockets. */
export function roomChannel(roomId: string): string {
  return `${ROOM_CHANNEL_PREFIX}${roomId}`;
}

/** Room id encoded in a channel, or `undefined` for a plain game channel. */
export function roomIdOfChannel(channel: string): string | undefined {
  return channel.startsWith(ROOM_CHANNEL_PREFIX) ? channel.slice(ROOM_CHANNEL_PREFIX.length) : undefined;
}

/** Channel registry used by the HTTP/WebSocket handlers. */
export interface RealtimeHub {
  /**
   * Adds a socket to a channel, moving it out of any previous channel.
   *
   * Called from the socket `open` handler, i.e. after a successful upgrade.
   */
  subscribe(channel: string, socket: ClientSocket): void;
  /** Removes a socket from its channel; safe to call for unknown sockets. */
  unsubscribe(socket: ClientSocket): void;
  /** The channel a socket currently belongs to, or `undefined`. */
  channelOf(socket: ClientSocket): string | undefined;
  /** Sends one frame to every open socket of a channel; never throws. */
  broadcast(channel: string, message: ServerMessage): void;
  /** Sends one frame to a single socket, tolerating a dead connection. */
  send(socket: ClientSocket, message: ServerMessage): void;
  /** Number of sockets currently subscribed to a channel. */
  clientCount(channel: string): number;
  /** Every socket currently subscribed to a channel. */
  socketsIn(channel: string): readonly ClientSocket[];
  /**
   * Terminates every socket and forgets all channels.
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
  const socketsByChannel = new Map<string, Set<ClientSocket>>();
  // Reverse index: makes `unsubscribe` independent of `ws.data` and keeps
  // `channelOf` cheap. Weak so a dropped socket never leaks.
  const channelBySocket = new WeakMap<ClientSocket, string>();
  const { logger } = options;

  const unsubscribe = (socket: ClientSocket): void => {
    const channel = channelBySocket.get(socket);
    if (channel === undefined) return;
    channelBySocket.delete(socket);

    const sockets = socketsByChannel.get(channel);
    if (sockets === undefined) return;
    sockets.delete(socket);
    if (sockets.size === 0) socketsByChannel.delete(channel);
  };

  const send = (socket: ClientSocket, message: ServerMessage): void => {
    if (socket.readyState !== SOCKET_OPEN) {
      unsubscribe(socket);
      return;
    }
    try {
      socket.send(serializeServerMessage(message));
    } catch (error) {
      logger?.warn("websocket send failed", { channel: channelBySocket.get(socket), error });
      unsubscribe(socket);
    }
  };

  return {
    subscribe(channel, socket) {
      unsubscribe(socket);
      let sockets = socketsByChannel.get(channel);
      if (sockets === undefined) {
        sockets = new Set();
        socketsByChannel.set(channel, sockets);
      }
      sockets.add(socket);
      channelBySocket.set(socket, channel);
    },

    unsubscribe,

    channelOf(socket) {
      return channelBySocket.get(socket);
    },

    broadcast(channel, message) {
      const sockets = socketsByChannel.get(channel);
      if (sockets === undefined || sockets.size === 0) return;

      // Serialise once: every subscriber gets the same frame.
      const frame = serializeServerMessage(message);
      for (const socket of [...sockets]) {
        // A socket may have closed while we iterated; skip and let `close`
        // (or this check) clean the channel up.
        if (socket.readyState !== SOCKET_OPEN) {
          unsubscribe(socket);
          continue;
        }
        try {
          socket.send(frame);
        } catch (error) {
          logger?.warn("websocket send failed", { channel, error });
          unsubscribe(socket);
        }
      }
    },

    send,

    clientCount(channel) {
      return socketsByChannel.get(channel)?.size ?? 0;
    },

    socketsIn(channel) {
      return [...(socketsByChannel.get(channel) ?? [])];
    },

    closeAll() {
      for (const sockets of [...socketsByChannel.values()]) {
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
      socketsByChannel.clear();
    },
  };
}
