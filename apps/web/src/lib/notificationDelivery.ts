type Delivery = {
  reserve: (token: string) => Promise<boolean>;
  show: () => Promise<boolean>;
  finish: (token: string, accepted: boolean) => Promise<unknown>;
};

/** Retry failed native delivery without racing reactive renders or other devices. */
export class NotificationDelivery {
  private pending = new Set<string>();
  private retries = new Map<string, { attempts: number; after: number }>();
  private accepted = new Set<string>();

  async deliver(id: string, delivery: Delivery) {
    const retry = this.retries.get(id);
    if (this.pending.has(id) || (retry && (retry.attempts >= 3 || retry.after > Date.now()))) return;
    this.pending.add(id);
    const token = crypto.randomUUID();
    let attempted = false;
    let finished = false;
    try {
      if (!await delivery.reserve(token)) return;
      attempted = true;
      // If acknowledgment failed, retry it without ringing a second time.
      let accepted = this.accepted.has(id);
      if (!accepted) { try { accepted = await delivery.show(); } catch { /* Release the lease and retry. */ } }
      if (accepted) this.accepted.add(id);
      await delivery.finish(token, accepted);
      finished = accepted;
    } catch { /* Offline or revoked access: the lease expires and inbox history remains. */ }
    finally {
      this.pending.delete(id);
      this.retries.set(id, { attempts: finished ? 3 : (retry?.attempts ?? 0) + (attempted ? 1 : 0), after: Date.now() + 30_000 });
      // Only the latest 100 inbox items can be delivered; bound session bookkeeping.
      if (this.retries.size > 200) {
        const oldest = this.retries.keys().next().value;
        if (oldest) { this.retries.delete(oldest); this.accepted.delete(oldest); }
      }
    }
  }
}
