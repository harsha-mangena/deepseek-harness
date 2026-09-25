/**
 * The System 1 coordinator's inbox: durable pending-work queues behind
 * the same {@link Inbox} contract the standard agent runtime uses.
 *
 * Every input carries a stable {@link System1InputId} assigned at
 * enqueue. When a journal is bound, each mutation is reported to it —
 * enqueues, removals, and replacements — so the owner can persist the
 * transitions to the session log and recovery rebuilds only the inputs
 * that are still pending. Without a journal the inbox is memory-only,
 * exactly like the plain runtime inbox.
 */
import { newSystem1InputId } from './input-id.ts'
import type { System1InputId } from './types.ts'
import type { Inbox, InboxTarget } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'

/** The two pending-work boundaries the coordinator serves. */
export type System1InboxTarget = InboxTarget

/** One pending input: its stable identity plus the queued message. */
export interface InboxEntry {
  /** Stable identity assigned at enqueue; survives restarts via the session log. */
  inputId: System1InputId
  /** The queued message. */
  message: UserMessage
}

/** One claimed input: the pending entry plus the boundary it was taken from. */
export interface ClaimedInboxInput extends InboxEntry {
  /** The pending list the input was claimed from. */
  target: System1InboxTarget
}

/**
 * How a removal from the pending lists is journaled. `claimed` means a
 * turn took ownership of the input; `discarded` means it was dropped
 * without being processed. `auto` leaves the choice to the journal owner
 * (the coordinator resolves it against the driver-turn lifecycle).
 */
export type InboxRemovalDisposition = 'claimed' | 'discarded' | 'auto'

/**
 * Facts the inbox reports to its journal for every pending-list
 * mutation. The owner persists these as `system1/inbox` and
 * `system1/inbox-transition` session events.
 */
export type InboxJournalEvent =
  /** A message entered a pending list. */
  | { kind: 'enqueued'; target: System1InboxTarget; entry: InboxEntry }
  /** Entries left a pending list; the owner labels each claimed or discarded. */
  | {
    kind: 'removed'
    target: System1InboxTarget
    entries: readonly InboxEntry[]
    disposition: InboxRemovalDisposition
  }
  /** An entry was replaced in place; its stable identity is preserved. */
  | { kind: 'replaced'; target: System1InboxTarget; entry: InboxEntry }

/** In-memory System 1 inbox implementing the runtime inbox contract. */
export class System1Inbox implements Inbox {
  #nextTurn: InboxEntry[] = []
  #nextStep: InboxEntry[] = []
  #journal: ((event: InboxJournalEvent) => void) | undefined

  /**
   * @param journal - receives every pending-list mutation; omit for a
   * memory-only inbox with no durability.
   */
  constructor(journal?: (event: InboxJournalEvent) => void) {
    this.#journal = journal
  }

  /** Prompts awaiting individual turns. */
  get nextTurn(): readonly UserMessage[] {
    return this.#nextTurn.map((entry) => entry.message)
  }

  /** Input awaiting the next step boundary. */
  get nextStep(): readonly UserMessage[] {
    return this.#nextStep.map((entry) => entry.message)
  }

  /**
   * Pending entries with their stable identities, for consumers that
   * need to track inputs across restarts.
   * @param target - pending list to inspect.
   * @returns a snapshot of the pending entries in queue order.
   */
  entries(target: System1InboxTarget): readonly InboxEntry[] {
    return [...this.#list(target)]
  }

  /**
   * Remove every pending message, next-step before next-turn, and report
   * the removal to the journal.
   * @param disposition - how the removal is journaled; `auto` leaves the
   * choice to the journal owner.
   */
  clear(disposition: InboxRemovalDisposition = 'auto'): void {
    for (const target of ['next-step', 'next-turn'] as const) {
      const entries = this.#list(target).splice(0)
      if (entries.length > 0) {
        this.#journal?.({ kind: 'removed', target, entries, disposition })
      }
    }
  }

  /**
   * Clear without journaling. Replay only: {@link recover} rebuilds the
   * queues from the session log, so the in-memory state is reset
   * silently instead of recording a discard transition.
   */
  resetForReplay(): void {
    this.#nextTurn = []
    this.#nextStep = []
  }

  /**
   * Append one message to a pending list, assigning it a stable input id.
   * @param target - pending list to extend.
   * @param message - message to append.
   * @returns the enqueued entry with its stable input id.
   */
  enqueue(target: System1InboxTarget, message: UserMessage): InboxEntry {
    const entry: InboxEntry = { inputId: newSystem1InputId(), message }
    this.#list(target).push(entry)
    this.#journal?.({ kind: 'enqueued', target, entry })
    return entry
  }

  /**
   * Append one message to a pending list.
   * @param target - pending list to extend.
   * @param message - message to append.
   */
  append(target: System1InboxTarget, message: UserMessage): void {
    this.enqueue(target, message)
  }

  /**
   * Prepend one message to a pending list.
   * @param target - pending list to extend.
   * @param message - message to prepend.
   */
  prepend(target: System1InboxTarget, message: UserMessage): void {
    const entry: InboxEntry = { inputId: newSystem1InputId(), message }
    this.#list(target).unshift(entry)
    this.#journal?.({ kind: 'enqueued', target, entry })
  }

  /**
   * Replace one pending message in place. The entry keeps its stable
   * input id; the replacement is journaled so replay rebuilds it.
   * @param messageId - identity of the pending message to replace.
   * @param newMessage - replacement message.
   * @returns whether the message was still pending.
   */
  replace(messageId: MessageId, newMessage: UserMessage): boolean {
    for (const target of ['next-step', 'next-turn'] as const) {
      const list = this.#list(target)
      const index = list.findIndex((entry) => entry.message.id === messageId)
      const current = list[index]
      if (index >= 0 && current !== undefined) {
        const entry: InboxEntry = { inputId: current.inputId, message: newMessage }
        list[index] = entry
        this.#journal?.({ kind: 'replaced', target, entry })
        return true
      }
    }
    return false
  }

  /**
   * Remove one pending message and report the removal to the journal.
   * @param messageId - identity of the pending message to remove.
   * @param disposition - how the removal is journaled; `auto` leaves the
   * choice to the journal owner.
   * @returns whether the message was still pending.
   */
  remove(messageId: MessageId, disposition: InboxRemovalDisposition = 'auto'): boolean {
    for (const target of ['next-step', 'next-turn'] as const) {
      const list = this.#list(target)
      const index = list.findIndex((entry) => entry.message.id === messageId)
      if (index >= 0) {
        const [entry] = list.splice(index, 1)
        if (entry === undefined) return false
        this.#journal?.({ kind: 'removed', target, entries: [entry], disposition })
        return true
      }
    }
    return false
  }

  /**
   * Apply standard splice semantics to a pending list. Removed messages
   * are reported to the journal; inserted messages are enqueued with
   * fresh stable input ids.
   * @param target - pending list to mutate.
   * @param start - splice position.
   * @param deleteCount - maximum number of messages to remove.
   * @param inserted - messages to insert at the resolved position.
   * @param disposition - how removals are journaled; `auto` leaves the
   * choice to the journal owner.
   * @returns messages removed by the splice.
   */
  splice(
    target: System1InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    disposition: InboxRemovalDisposition = 'auto',
  ): UserMessage[] {
    const list = this.#list(target)
    const removed = list.splice(start, deleteCount)
    const fresh = inserted.map(
      (message): InboxEntry => ({ inputId: newSystem1InputId(), message }),
    )
    list.splice(start, 0, ...fresh)
    if (removed.length > 0) {
      this.#journal?.({ kind: 'removed', target, entries: removed, disposition })
    }
    for (const entry of fresh) {
      this.#journal?.({ kind: 'enqueued', target, entry })
    }
    return removed.map((entry) => entry.message)
  }

  /**
   * Claim every pending input for the current turn, next-step before
   * next-turn. Claimed inputs leave the pending lists and are journaled
   * as `claimed`, so recovery never requeues them. This is the durable
   * drain primitive the driver uses before persisting request/attempt
   * identities and dispatching.
   * @returns the claimed inputs with their stable identities, in drain order.
   */
  claimAll(): ClaimedInboxInput[] {
    const claimed: ClaimedInboxInput[] = []
    for (const target of ['next-step', 'next-turn'] as const) {
      const entries = this.#list(target).splice(0)
      for (const entry of entries) {
        claimed.push({ target, ...entry })
      }
      if (entries.length > 0) {
        this.#journal?.({ kind: 'removed', target, entries, disposition: 'claimed' })
      }
    }
    return claimed
  }

  /**
   * Rebuild one pending input during replay with a caller-supplied
   * identity. No journal output: the session log already records the
   * enqueue.
   * @param target - pending list to extend.
   * @param inputId - stable identity from the session log.
   * @param message - message to restore.
   */
  restorePending(target: System1InboxTarget, inputId: System1InputId, message: UserMessage): void {
    this.#list(target).push({ inputId, message })
  }

  /** Resolve a target to its backing list. */
  #list(target: System1InboxTarget): InboxEntry[] {
    return target === 'next-turn' ? this.#nextTurn : this.#nextStep
  }
}
