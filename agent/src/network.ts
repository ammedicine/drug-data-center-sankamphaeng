/**
 * Which network card this machine actually uses to reach Central.
 *
 * Listing os.networkInterfaces() and taking the first non-internal entry gets
 * this wrong on a real รพ.สต. PC: Windows reports Bluetooth PAN, VirtualBox and
 * VMware adapters, Hyper-V switches and disconnected Ethernet ports alongside
 * the Wi-Fi card that is carrying the traffic, and the order is not meaningful.
 *
 * So this asks the operating system instead: open a connection to Central, read
 * which local address the kernel chose for it, and match that address back to
 * an interface. Whatever answers is the card actually in use, by definition.
 */
import { connect } from "node:net";
import { networkInterfaces } from "node:os";

export interface NetworkIdentity {
  macAddress: string | null;
  ipAddress: string | null;
  interfaceName: string | null;
}

const EMPTY: NetworkIdentity = { macAddress: null, ipAddress: null, interfaceName: null };

/** The local address the OS picks when talking to `host`. */
function localAddressFor(host: string, port: number, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (value: string | null) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(null));
    socket.once("connect", () => done(socket.localAddress ?? null));
    socket.once("error", () => done(null));
  });
}

/**
 * Resolves the identity of the interface used to reach `centralUrl`.
 *
 * Returns nulls rather than throwing or guessing: an agent that cannot work
 * out its own network card must still send its heartbeat.
 */
export async function resolveNetworkIdentity(centralUrl: string): Promise<NetworkIdentity> {
  let host: string;
  let port: number;
  try {
    const url = new URL(centralUrl);
    host = url.hostname;
    port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
  } catch {
    return EMPTY;
  }

  const local = await localAddressFor(host, port, 3000);
  if (!local) return EMPTY;

  // Strip the IPv4-mapped IPv6 form (::ffff:192.168.1.9) before matching.
  const address = local.startsWith("::ffff:") ? local.slice(7) : local;

  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.address !== address) continue;
      // Loopback says nothing about which machine this is - it is the same on
      // every PC - so report nothing rather than something that looks like an
      // answer. This is the normal case only on a developer box, where Central
      // runs locally.
      if (entry.internal) return EMPTY;
      // 00:00:00:00:00:00 is what Windows reports for adapters with no
      // hardware address; it identifies nothing either.
      const mac = entry.mac && entry.mac !== "00:00:00:00:00:00" ? entry.mac : null;
      return { macAddress: mac, ipAddress: address, interfaceName: name };
    }
  }

  // An address that matches no interface: report the address, admit the rest.
  return { macAddress: null, ipAddress: address, interfaceName: null };
}
