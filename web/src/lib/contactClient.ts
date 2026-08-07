// Contact / support inbox — WRITES (algokit-utils + wallet signer). Reads live in
// contact.ts, mirroring the reads/writes split already used for MagnetFi.

import algosdk, { type TransactionSigner } from "algosdk";
import { AlgorandClient, microAlgo } from "@algorandfoundation/algokit-utils";
import { encodeNote, type SupportApp, DEFAULT_CHANNEL } from "./contact";

const GROUP_LIMIT = 16; // Algorand atomic group cap

export function makeAlgorand(algod: algosdk.Algodv2, signer: TransactionSigner): AlgorandClient {
  const algorand = AlgorandClient.fromClients({ algod });
  algorand.setDefaultSigner(signer);
  return algorand;
}

/** Submit a new support ticket; optionally subscribes in the same signature. */
export async function sendTicket(
  al: AlgorandClient,
  sender: string,
  admin: string,
  payload: { msg: string; txnId?: string; app?: SupportApp },
  subscribe: boolean
): Promise<string> {
  let grp = al.newGroup().addPayment({
    sender, receiver: admin, amount: microAlgo(0),
    note: encodeNote("support", payload),
  });
  if (subscribe) {
    grp = grp.addPayment({
      sender, receiver: admin, amount: microAlgo(0),
      note: encodeNote("subscribe", { channel: DEFAULT_CHANNEL }),
    });
  }
  const result = await grp.send();
  return result.txIds[0];
}

/** Toggle subscription on its own (no ticket attached). */
export async function sendSubscription(
  al: AlgorandClient, sender: string, admin: string, subscribed: boolean
): Promise<void> {
  await al.send.payment({
    sender, receiver: admin, amount: microAlgo(0),
    note: encodeNote(subscribed ? "subscribe" : "unsubscribe", { channel: DEFAULT_CHANNEL }),
  });
}

/** Admin: reply to a ticket. `thread` is the root ticket's own txn ID. */
export async function sendReply(
  al: AlgorandClient, admin: string, recipient: string, msg: string, thread: string
): Promise<void> {
  await al.send.payment({
    sender: admin, receiver: recipient, amount: microAlgo(0),
    note: encodeNote("reply", { msg, thread }),
  });
}

/**
 * Admin: broadcast to every current subscriber. Sent in atomic groups of ≤16 (the
 * network's group cap) so each chunk is a single wallet signature — a known scaling
 * ceiling for large subscriber counts (see plan notes), acceptable for v1.
 */
export async function sendBroadcast(
  al: AlgorandClient,
  admin: string,
  subscribers: string[],
  msg: string,
  bid: string,
  onProgress?: (sent: number, total: number) => void
): Promise<void> {
  const channel = DEFAULT_CHANNEL;
  let sent = 0;
  for (let i = 0; i < subscribers.length; i += GROUP_LIMIT) {
    const chunk = subscribers.slice(i, i + GROUP_LIMIT);
    let grp = al.newGroup();
    for (const receiver of chunk) {
      grp = grp.addPayment({
        sender: admin, receiver, amount: microAlgo(0),
        note: encodeNote("update", { msg, channel, bid }),
      });
    }
    await grp.send();
    sent += chunk.length;
    onProgress?.(sent, subscribers.length);
  }
}
