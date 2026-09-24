/**
 * The System 1 coordinator's inbox: durable pending-work queues behind
 * the same {@link Inbox} contract the standard agent runtime uses.
 *
 * Phase 0 keeps storage in memory. Durable splice events (the
 * `agent/inbox/spliced` session vocabulary) arrive with the persistence
 * phase; until then the queues are process-local and {@link clear}
 * simply empties them.
 */
import type { Inbox, InboxTarget } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'

/** The two pending-work boundaries the coordinator serves. */
export type System1InboxTarget = InboxTarget

/** In-memory System 1 inbox implementing the runtime inbox contract. */
export class System1Inbox implements Inbox {
  #nextTurn: UserMessage[] = []
  #nextStep: UserMessage[] = []

  /** Prompts awaiting individual turns. */
  get nextTurn(): readonly UserMessage[] {
    return this.#nextTurn
  }

  /** Input awaiting the next step boundary. */
  get nextStep(): readonly UserMessage[] {
    return this.#nextStep
  }

  /**
   * Remove every pending message, next-step before next-turn.
   */
  clear(): void {
    this.#nextStep = []
    this.#nextTurn = []
  }

  /**
   * Append one message to a pending list.
   * @param target - pending list to extend.
   * @param message - message to append.
   */
  append(target: System1InboxTarget, message: UserMessage): void {
    this.#list(target).push(message)
  }

  /**
   * Prepend one message to a pending list.
   * @param target - pending list to extend.
   * @param message - message to prepend.
   */
  prepend(target: System1InboxTarget, message: UserMessage): void {
    this.#list(target).unshift(message)
  }

  /**
   * Replace one pending message in place.
   * @param messageId - identity of the pending message to replace.
   * @param newMessage - replacement message.
   * @returns whether the message was still pending.
   */
  replace(messageId: MessageId, newMessage: UserMessage): boolean {
    for (const target of ['next-step', 'next-turn'] as const) {
      const list = this.#list(target)
      const index = list.findIndex(message => message.id === messageId)
      if (index >= 0) {
        list[index] = newMessage
        return true
      }
    }
    return false
  }

  /**
   * Remove one pending message.
   * @param messageId - identity of the pending message to remove.
   * @returns whether the message was still pending.
   */
  remove(messageId: MessageId): boolean {
    for (const target of ['next-step', 'next-turn'] as const) {
      const list = this.#list(target)
      const index = list.findIndex(message => message.id === messageId)
      if (index >= 0) {
        list.splice(index, 1)
        return true
      }
    }
    return false
  }

  /**
   * Apply standard splice semantics to a pending list.
   * @param target - pending list to mutate.
   * @param start - splice position.
   * @param deleteCount - maximum number of messages to remove.
   * @param inserted - messages to insert at the resolved position.
   * @returns messages removed by the splice.
   */
  splice(
    target: System1InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
  ): UserMessage[] {
    return this.#list(target).splice(start, deleteCount, ...inserted)
  }

  /** Resolve a target to its backing list. */
  #list(target: System1InboxTarget): UserMessage[] {
    return target === 'next-turn' ? this.#nextTurn : this.#nextStep
  }
}
