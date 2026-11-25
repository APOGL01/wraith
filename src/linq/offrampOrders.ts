/**
 * Reconciliation for offramp orders.
 *
 * The webhook used to write this update inline. The periodic sweep needs the
 * same write, and two implementations of "apply Linq's status to our row" is
 * how a webhook and a poll start disagreeing. Both now go through here.
 */

import { prisma } from "../db";
import { recordOrderTerminal, terminalStatusOf } from "../metrics";
import { isFailureStatus, recordMoneyFailure } from "./moneyFailures";
import { resolveEventNetwork } from "./webhook";

export interface OfframpReconciliationEvent {
  orderId: string;
  network?: string;
  status?: string;
  event: string;
  amountStableCoin?: number;
  amountNGN?: number;
  txHash?: string;
}

/**
 * Apply an event or status-poll result to an offramp order.
 *
 * Returns false when the network is invalid or the order is not ours. Nothing
 * here creates a row: an event for an order we never placed is not ours to act
 * on.
 *
 * Returns true without writing when the status and amounts are unchanged —
 * idempotent so a wallet polling a finished order and a re-delivered webhook
 * never re-fire money-failure counters or terminal metrics.
 */
export async function reconcileOfframpOrder(
  event: OfframpReconciliationEvent,
): Promise<boolean> {
  const network = resolveEventNetwork(event);
  if (!network) return false;

  const existing = await prisma.offrampOrder.findUnique({
    where: { network_orderId: { network, orderId: event.orderId } },
  });
  if (!existing) return false;

  const status = event.status ?? event.event;

  // Early-return when the status is unchanged: a wallet polling a finished
  // order and a re-delivered webhook must not re-fire money-failure counters,
  // terminal metrics, or issue unnecessary database writes.
  // Amounts are only written on a settlement transition (see below), so they
  // cannot change independently of a status change in normal operation.
  if (status === existing.status) return true;

  // Counted here rather than in the webhook so the sweep counts it too: either
  // path may be the one that first sees the ending. Comparing the row we just
  // read against the incoming status is what keeps a redelivered webhook, and a
  // wallet polling a finished order, from counting the same ending twice.
  const wasTerminal = terminalStatusOf(existing.status);
  const isTerminal = terminalStatusOf(status);

  // Only write settled amounts on a settlement transition. Writing them on
  // every status change (e.g. "processing") stores the in-flight amount as the
  // settled figure, which is wrong for the settled/cache display path.
  const isSettlement = isTerminal === "settled";

  await prisma.offrampOrder.update({
    where: { network_orderId: { network, orderId: event.orderId } },
    data: {
      status,
      ...(isSettlement && event.amountStableCoin != null
        ? { settledStableCoin: String(event.amountStableCoin) }
        : {}),
      ...(isSettlement && event.amountNGN != null
        ? { settledNGN: String(event.amountNGN) }
        : {}),
      ...(event.txHash ? { depositTxHash: event.txHash } : {}),
    },
  });

  // An offramp order that ended failed is the incident this table exists for:
  // the user's crypto was taken and the naira payout did not complete. Every
  // path — webhook, status poll and the periodic sweep — goes through this
  // function, and the (network, kind, orderId) key turns several sightings of
  // one failed order into one incident rather than several alarms.
  if (isFailureStatus(status)) {
    await recordMoneyFailure({
      network: existing.network,
      rail: "offramp",
      kind: "payout_rejected",
      orderId: event.orderId,
      publicId: existing.publicId,
      providerCode: status,
      message: `Offramp order ended as "${status}" — the naira payout did not complete.`,
    });
  }

  if (isTerminal && !wasTerminal) recordOrderTerminal("offramp", status);
  return true;
}
