# Pollen

> Fully offline, zero-internet, peer-to-peer messenger.
> Messages spread like a virus through human movement. No servers. No cloud. Just people carrying bytes.

You know how the plague spread across medieval Europe? Person to person, city to city, through nothing but human contact? Yeah, Pollen does that but with your encrypted messages, and hopefully with less death involved.

---

## Table of Contents

- [Why Does This Exist?](#why-does-this-exist)
- [How It Works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Commands](#commands)
- [Architecture](#architecture)
- [Encryption](#encryption)
- [Data Storage](#data-storage)
- [Configuration & Limits](#configuration--limits)
- [FAQ](#faq)
- [Contributing](#contributing)
- [License](#license)

---

## Why Does This Exist?

Because sometimes the internet just... isn't there. Natural disasters. Authoritarian shutdowns. That one corner of your college campus where WiFi goes to die. Remote villages. Underground bunkers (no judgment).

Pollen implements **Epidemic Routing**, a real protocol from Delay-Tolerant Networking (DTN) research — the same class of protocols NASA uses to communicate with spacecraft millions of miles away. If it's good enough for Mars, it's good enough for your group chat.

The idea is simple: your message copies itself to every Pollen user nearby. They walk away, go to a coffee shop, an airport, another city and their device spreads it further. Eventually, someone physically encounters the recipient, and the message delivers itself. All encrypted. All automatic. Zero internet at any point.

**Think of it as WhatsApp if WhatsApp had to survive the apocalypse.**

---

## How It Works

```
You                    Strangers              Recipient
 |                         |                      |
 |-- encrypt & store ----->|                      |
 |   (WiFi/hotspot)        |                      |
 |                         |-- carry physically -->|
 |                         |   (walk, drive, fly)  |
 |                         |                      |
 |                         |-- deliver on LAN ---->|
 |                         |                      |-- decrypt
 |                         |                      |
 |<------------- ACK (travels back the same way) -|
```

1. You send a message. It gets **encrypted** with the recipient's public key and stored locally.
2. Your device broadcasts it over **local WiFi/hotspot** to every nearby Pollen user.
3. Those users don't even know they're carrying it. Their devices just... have it. Like a cold.
4. When they move to a new network, the message spreads to everyone there too.
5. The moment a carrier lands on the same network as the recipient, the message delivers automatically.
6. An **ACK** receipt travels back to you the exact same way. Epidemically.

No central server. No internet backbone. Just mesh networking powered by human commutes.

---

## Prerequisites

- **Node.js >= 18** ([download](https://nodejs.org))
- A **C++ build toolchain** (required by `better-sqlite3`, the native SQLite addon):

| OS | Install |
|---|---|
| **Windows** | [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) + Python 3 |
| **macOS** | `xcode-select --install` |
| **Linux** | `sudo apt install build-essential python3` |

Verify your setup:

```bash
node -v    # should print v18.x.x or higher
npm -v     # should print a version number
```

---

## Installation

### From npm (recommended)

```bash
npm install -g pollen-transmit
```

> On macOS/Linux, you may need `sudo npm install -g pollen-transmit` if you get permission errors.

### From source

```bash
git clone https://github.com/sudogetshivam/pollen-transmit.git
cd pollen-transmit
npm install
npm link    # makes the 'pollen' command available globally
```

Verify installation:

```bash
pollen --version
```

---

## Quick Start

**1. Start the daemon**

```bash
pollen start
```

On first run, Pollen will ask for a username and generate your identity (e.g., `alice@f7a2`) along with an RSA-2048 keypair. Think of the identity as your Pollen phone number — share it with friends so they can message you.

> Keep this terminal window open. The daemon runs in the background, silently discovering peers and relaying messages. Open a new terminal for commands.

**2. Find people nearby**

```bash
pollen scan
```

Lists all Pollen users discovered on your current WiFi or hotspot. If your friend started their daemon nearby, they'll show up here.

**3. Send a message**

```bash
pollen send bob@b7d9 "Internet is overrated anyway"
```

This encrypts and queues the message. If Bob is on your network, it delivers instantly. If not, it starts spreading epidemically through everyone around you. The command returns a **Message ID** for tracking.

**4. Check delivery status**

```bash
pollen status <message-id>
```

Shows one of three states:
- **Undelivered** — sitting on your device, waiting for carriers
- **In Transit** — carriers are spreading it across networks
- **Delivered** — the recipient got it, and an ACK is on its way back to you

**5. Read incoming messages**

Messages arrive automatically while your daemon runs. Check your inbox:

```bash
# macOS / Linux
cat ~/.pollen/inbox.log

# Windows
type %USERPROFILE%\.pollen\inbox.log
```

**6. Stop the daemon**

```bash
pollen stop
```

---

## Commands

| Command | Description |
|---|---|
| `pollen start` | Start the background daemon. First run creates your identity and keys. |
| `pollen stop` | Shut down the daemon gracefully. |
| `pollen scan` | Discover Pollen peers on your current network. |
| `pollen send <identity> "<message>"` | Send an end-to-end encrypted message. |
| `pollen status <messageId>` | Track a message's delivery journey. |
| `pollen sync` | Force an immediate epidemic exchange with all known peers. |
| `pollen file <identity> <filepath>` | Send a file via epidemic routing. |
| `pollen --version` | Print the installed version. |
| `pollen --help` | Show all available commands. |

---

## Architecture

```
pollen-transmit/
├── bin/
│   └── pollen.js               # CLI entry point (Commander.js)
└── src/
    ├── cli/
    │   ├── ipc.js              # CLI <-> Daemon communication (IPC client)
    │   └── commands/
    │       ├── start.js        # Spawn daemon, create identity on first run
    │       ├── stop.js         # Send shutdown signal
    │       ├── scan.js         # Query daemon for discovered peers
    │       ├── send.js         # Encrypt and queue a message
    │       ├── status.js       # Query message delivery status
    │       ├── sync.js         # Trigger manual epidemic exchange
    │       └── file.js         # File transfer command
    ├── identity/
    │   └── index.js            # Username + shortID generation (e.g., alice@f7a2)
    ├── crypto/
    │   ├── keys.js             # RSA-2048 keypair generation and storage
    │   └── encrypt.js          # Hybrid AES-256-GCM + RSA-OAEP encryption
    ├── db/
    │   ├── index.js            # SQLite connection and schema setup
    │   ├── messages.js         # Message CRUD + peer key/IP storage
    │   └── cleanup.js          # TTL expiry and stale data cleanup
    └── daemon/
        ├── index.js            # Main daemon process (IPC server, event loop)
        ├── network.js          # IP polling and network change detection
        ├── udp.js              # UDP broadcast for peer discovery
        ├── tcp.js              # TCP for reliable message transfer
        └── epidemic.js         # Epidemic routing engine + ACK generation
```

### How the pieces fit together

The CLI is just a thin client. It does **zero networking**. Every command serializes a request over IPC (Unix socket on Linux/macOS, named pipe on Windows) to the daemon, which does all the heavy lifting.

The daemon runs detached in the background and manages:

- **UDP broadcast** every 15 seconds for peer discovery — announces your identity and public key
- **TCP connections** for reliable message transfer between peers
- **Epidemic forwarding** — continuously spreads pending messages to all known peers
- **Network change detection** — when you switch WiFi, triggers a fresh peer scan and epidemic exchange
- **Startup delivery sweep** — on boot, retries all pending messages against known peers
- **Stale peer cleanup** — removes peers not seen in 3+ minutes

### Key Design Decisions

| Decision | Why |
|---|---|
| IPC via Unix socket / named pipe | No port conflicts, no firewall headaches |
| Hybrid AES-256-GCM + RSA-OAEP | RSA alone caps at ~190 bytes. Hybrid handles messages of any length. |
| Daemon spawned detached | CLI exits immediately. Daemon lives independently. Your terminal is free. |
| `windowsHide: true` | No random console window popping up on Windows (you're welcome) |
| Max 20 hops | Prevents messages from circulating forever. If it hasn't arrived in 20 hops, it probably won't. |
| 7-day TTL | Messages expire after a week. Keeps carrier devices from becoming digital hoarders. |
| TCP with UDP fallback | TCP for reliability, UDP when firewalls get in the way |

---

## Encryption

Every message is end-to-end encrypted. Relay nodes (the strangers carrying your messages) can see *who* the message is for, but **cannot read the contents**. Period.

Here's what happens under the hood:

```
Sender                          Relay / Carrier              Recipient
  |                                    |                         |
  |  1. Generate random AES-256 key   |                         |
  |  2. Encrypt message with AES-GCM  |                         |
  |  3. Encrypt AES key with          |                         |
  |     recipient's RSA public key    |                         |
  |                                    |                         |
  |--- encrypted blob (opaque) ------->|                         |
  |    (can see destination,           |                         |
  |     cannot read content)           |--- encrypted blob ----->|
  |                                    |                         |
  |                                    |    4. Decrypt AES key   |
  |                                    |       with private key  |
  |                                    |    5. Decrypt message   |
  |                                    |       with AES key      |
  |                                    |                         |
  |<============ ACK (epidemic route back) ======================|
```

- **AES-256-GCM** handles the actual message encryption (fast, no size limit, authenticated)
- **RSA-2048 OAEP** wraps the AES key so only the recipient can unwrap it
- A fresh AES key is generated **per message** — compromising one key reveals nothing about any other message

Even if every single relay node was actively malicious, they'd just be carrying encrypted gibberish. The only device that can read the message is the one holding the recipient's private key.

---

## Data Storage

Everything lives in `~/.pollen/`:

| File/Directory | Purpose |
|---|---|
| `identity.json` | Your username and short ID |
| `keys/public.pem` | Your RSA public key (shared with peers) |
| `keys/private.pem` | Your RSA private key (never leaves your machine, mode `0600`) |
| `pollen.db` | SQLite database: messages, peer keys, peer IPs |
| `inbox.log` | Received messages log |
| `daemon.pid` | PID of the running daemon process |
| `daemon.log` | Daemon runtime logs |

> Your private key is stored with restricted file permissions. Don't share it. Don't back it up to Google Drive. Don't tattoo it on your arm. Basically, just leave it alone.

---

## Configuration & Limits

| Parameter | Value | Notes |
|---|---|---|
| Max hop count | 20 | Message is dropped after 20 relays |
| Default TTL | 7 days | Messages expire and get cleaned up |
| UDP heartbeat | Every 15s | How often your device announces itself |
| Stale peer timeout | 3 minutes | Peers not seen in 3 min are removed |
| RSA key size | 2048 bits | Generated once on first `pollen start` |
| AES key size | 256 bits | Fresh random key per message |
| AES mode | GCM | Authenticated encryption with 96-bit IV |

These are sensible defaults. The hop count prevents messages from bouncing around the network forever (imagine a message that just won't take the hint). The 7-day TTL keeps your database from slowly becoming a digital landfill.

---

## FAQ

**Q: Do both users need to be online at the same time?**
No. That's the entire point. You send a message, it starts spreading. The recipient can come online days later in a completely different city. As long as the epidemic chain reaches them within the TTL window, they'll get it.

**Q: What if nobody is running Pollen near me?**
Then your message waits patiently on your device. The moment someone running Pollen connects to your network, it copies over. Patience is a virtue, and your message has plenty of it.

**Q: Is this actually secure?**
Yes. AES-256-GCM + RSA-2048 is the same class of encryption used by banks, governments, and that one friend who encrypts their grocery lists. Relay nodes carry your messages but literally cannot read them.

**Q: How do I share my identity with someone?**
The old-fashioned way. Tell them in person, text it, write it on a napkin, send it via carrier pigeon — whatever works. Your identity (`username@shortid`) is not a secret; it's like a phone number.

**Q: Can I use this over a mobile hotspot?**
Absolutely. Any local network works — WiFi, hotspot, even a direct device-to-device connection. Pollen doesn't care how you're connected, just that you are.

**Q: Why SQLite?**
Because it's embedded, requires zero configuration, handles concurrent reads well, and the binary size is smaller than your average npm dependency list. Plus, it won't ghost you with connection pool errors at 3 AM.

**Q: What happens if two people send messages at the same time?**
They both work fine. Messages have unique UUIDs and the epidemic protocol handles deduplication. If a device already has a copy of a message, it rejects the duplicate. No echoes, no infinite loops.

**Q: Is this a blockchain?**
No. Please stop asking. There is no ledger, no mining, no tokens, no gas fees. Just encrypted messages being carried by humans. Like pigeons, but with RSA keys.

---

## Contributing

Contributions are welcome. The codebase is intentionally straightforward — no framework soup, no transpilers, no build steps beyond `npm install`. Just Node.js doing what Node.js does.

1. Fork the repository
2. Create your feature branch: `git checkout -b feature/your-feature`
3. Make your changes
4. Test locally by running `pollen start` on two machines on the same network
5. Commit: `git commit -m "Add your feature"`
6. Push: `git push origin feature/your-feature`
7. Open a pull request

If you find a bug, [open an issue](https://github.com/sudogetshivam/pollen-transmit/issues). If you find a security vulnerability, please **do not** open a public issue — reach out directly.

---

## License

[MIT](LICENSE) — do whatever you want with it. Just don't blame us if your epidemic messages accidentally take over a small town's WiFi network.

---

<p align="center">
  <strong>Built for a world where the internet isn't guaranteed.</strong><br>
  <em>Because sometimes the most reliable network is the one that walks.</em>
</p>
