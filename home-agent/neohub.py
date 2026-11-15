#!/usr/bin/env python3
"""Heatmiser neoHub (2nd gen) over its local WebSocket API, stdlib only.

Read-only by design for now: the only command this module ever sends is
GET_LIVE_DATA. There is no SET_* anywhere in this file, so a bug here can
report a wrong temperature but cannot change one.

The hub listens on wss://<hub>:4243 with a self-signed certificate (no
CA could sign a LAN address), so certificate checks are off for this one
connection. That is acceptable only because the hub is addressed by its
LAN IP from inside the house; NEOHUB_HOST must never be a public name.

Auth is an API token created in the Heatmiser Neo app (Settings -> API).
It lives in the agent's .env as NEOHUB_TOKEN and nowhere else.

Run directly to test from the NAS (reads NEOHUB_HOST / NEOHUB_TOKEN from
the environment, never prints the token):

    docker exec dashboard-agent python /app/neohub.py
"""

import base64
import ipaddress
import json
import os
import socket
import ssl
import struct
import sys

PORT = 4243
TIMEOUT = 10


def _check_lan(host):
    # A LAN address only: the certificate check is off, so a public name
    # here would be a real man-in-the-middle risk, not a theoretical one.
    try:
        addr = ipaddress.ip_address(socket.gethostbyname(host))
    except (OSError, ValueError) as err:
        raise ValueError(f"NEOHUB_HOST {host!r} doesn't resolve: {err}")
    if not addr.is_private:
        raise ValueError(f"NEOHUB_HOST must be a LAN address, got {addr}")


def _recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("hub closed the connection")
        buf += chunk
    return buf


def _send_frame(sock, payload, opcode=0x1):
    header = bytearray([0x80 | opcode])  # FIN + opcode
    n = len(payload)
    if n < 126:
        header.append(0x80 | n)
    elif n < 65536:
        header.append(0x80 | 126)
        header += struct.pack("!H", n)
    else:
        header.append(0x80 | 127)
        header += struct.pack("!Q", n)
    mask = os.urandom(4)  # client frames must be masked
    header += mask
    sock.sendall(bytes(header) + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))


def _send_text(sock, text):
    _send_frame(sock, text.encode("utf-8"), 0x1)


def _recv_message(sock):
    """One whole text message, reassembling fragments, answering pings."""
    parts = []
    while True:
        b1, b2 = _recv_exact(sock, 2)
        fin, opcode = b1 & 0x80, b1 & 0x0F
        n = b2 & 0x7F
        if n == 126:
            n = struct.unpack("!H", _recv_exact(sock, 2))[0]
        elif n == 127:
            n = struct.unpack("!Q", _recv_exact(sock, 8))[0]
        mask = _recv_exact(sock, 4) if b2 & 0x80 else None
        data = _recv_exact(sock, n)
        if mask:
            data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        if opcode == 0x8:
            raise ConnectionError("hub closed the WebSocket")
        if opcode == 0x9:  # ping -> pong
            _send_frame(sock, data, 0xA)
            continue
        if opcode in (0x1, 0x0, 0x2):
            parts.append(data)
            if fin:
                return b"".join(parts).decode("utf-8", "replace")


def _connect(host):
    raw = socket.create_connection((host, PORT), timeout=TIMEOUT)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    sock = ctx.wrap_socket(raw, server_hostname=host)
    key = base64.b64encode(os.urandom(16)).decode()
    sock.sendall((
        f"GET / HTTP/1.1\r\nHost: {host}:{PORT}\r\nUpgrade: websocket\r\n"
        f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n"
    ).encode())
    head = b""
    while b"\r\n\r\n" not in head:
        chunk = sock.recv(1024)
        if not chunk:
            raise ConnectionError("hub closed during the WebSocket handshake")
        head += chunk
    status = head.split(b"\r\n", 1)[0].decode(errors="replace")
    if " 101 " not in status + " ":
        raise ConnectionError(f"WebSocket handshake refused: {status}")
    return sock


def command(host, token, name, arg=0):
    """Send one hub command, return the parsed response."""
    _check_lan(host)
    sock = _connect(host)
    try:
        inner = {
            "token": token,
            # The hub's own docs write the command as a Python-style dict
            # string with single quotes; it is sent exactly that way.
            "COMMANDS": [{"COMMAND": "{'%s':%s}" % (name, json.dumps(arg)), "COMMANDID": 1}],
        }
        _send_text(sock, json.dumps({"message_type": "hm_get_command_queue", "message": json.dumps(inner)}))
        try:
            reply = json.loads(_recv_message(sock))
        except (TimeoutError, socket.timeout):
            # Seen live on firmware 2218: a made-up token gets a completed
            # handshake and then silence, while the real token in the
            # same message shape gets an answer at once.
            raise RuntimeError("The hub accepted the connection but never replied -- check the API token in the Neo app (Settings -> API).")
    finally:
        try:
            sock.close()
        except OSError:
            pass
    body = reply.get("response")
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except ValueError:
            pass
    if reply.get("message_type") != "hm_set_command_response" or body is None:
        raise RuntimeError(f"Unexpected hub reply: {json.dumps(reply)[:300]}")
    if isinstance(body, dict) and body.get("error"):
        raise RuntimeError(f"Hub error: {body['error']}")
    return body


def _num(v):
    try:
        return round(float(v), 1)
    except (TypeError, ValueError):
        return None


def live(host, token):
    """Zones with current and target temperature. Read-only."""
    data = command(host, token, "GET_LIVE_DATA", 0)
    zones = []
    for d in data.get("devices", []) or []:
        zones.append({
            "zone": d.get("ZONE_NAME"),
            "actual": _num(d.get("ACTUAL_TEMP")),
            "target": _num(d.get("SET_TEMP")),
            "heating": bool(d.get("HEAT_ON")),
            "hold": bool(d.get("HOLD_ON")),
            "standby": bool(d.get("STANDBY")),
            "offline": bool(d.get("OFFLINE")),
            "away": bool(d.get("AWAY")),
        })
    return {"zones": zones, "hubTime": data.get("HUB_TIME")}


if __name__ == "__main__":
    host = os.environ.get("NEOHUB_HOST", "").strip()
    token = os.environ.get("NEOHUB_TOKEN", "").strip()
    if not host:
        sys.exit("Set NEOHUB_HOST (the hub's LAN IP)")
    print(f"Hub {host}:{PORT}, token {'set (' + str(len(token)) + ' chars)' if token else 'NOT set'}")
    if "--raw-keys" in sys.argv:
        data = command(host, token, "GET_LIVE_DATA", 0)
        first = (data.get("devices") or [{}])[0]
        print("top-level keys:", sorted(data.keys()))
        print("device keys:", sorted(first.keys()))
    else:
        print(json.dumps(live(host, token), indent=2))
