/**
 * Legal holds (§15).
 *
 * ---------------------------------------------------------------------------
 * A HOLD IS NOT A FLAG
 * ---------------------------------------------------------------------------
 * The `legal_hold` boolean is the predicate the deletion query reads. It is not
 * the hold. The hold is a row naming an owner, a case and a reason, and the
 * boolean is derived from whether any such row is still open.
 *
 * That distinction is what stops the flag becoming permanent by accident.
 * Anyone can set a boolean; nobody can set this without saying who they are and
 * why, and releasing it is a recorded act rather than an edit. Data held under
 * a case that closed goes back on its normal expiry, and the record that it was
 * held survives the release.
 *
 * Every placement and release writes an `admin_audit` row (I11).
 */
import { randomUUID } from 'node:crypto';

import type { Database } from './pool';
import type { SqlExecutor } from './repositories';

export type HoldSubject = 'conversation' | 'message' | 'report';

export interface HoldRequest {
  readonly subjectType: HoldSubject;
  readonly subjectId: string;
  readonly caseId: string;
  readonly owner: string;
  readonly justification: string;
}

export interface HoldResult {
  readonly holdId: string;
  /** False when the subject row does not exist; nothing was held. */
  readonly applied: boolean;
}

/** Which table carries the `legal_hold` flag for each subject type. */
const TABLE: Record<HoldSubject, { table: string; key: string }> = {
  conversation: { table: 'conversations', key: 'conversation_id' },
  message: { table: 'messages', key: 'message_id' },
  report: { table: 'reports', key: 'report_id' },
};

export class LegalHolds {
  constructor(private readonly db: Database) {}

  /**
   * Place a hold. The hold row, the flag and the audit row are one transaction:
   * a flag set without a recorded reason is exactly the state this exists to
   * prevent, and a hold row whose flag never got set would suspend nothing.
   */
  async place(request: HoldRequest): Promise<HoldResult> {
    const holdId = randomUUID();
    const target = TABLE[request.subjectType];

    return this.db.transaction(async (client) => {
      const updated = await client.query(
        `update ${target.table} set legal_hold = true where ${target.key} = $1`,
        [request.subjectId],
      );
      if ((updated.rowCount ?? 0) === 0) {
        // Nothing to hold. Recording the attempt anyway would create a hold
        // that suspends nothing and confuses whoever reviews the case.
        return { holdId, applied: false };
      }

      await client.query(
        `insert into legal_holds
           (hold_id, subject_type, subject_id, case_id, owner, justification, created_at)
         values ($1, $2, $3, $4, $5, $6, now())`,
        [
          holdId,
          request.subjectType,
          request.subjectId,
          request.caseId,
          request.owner,
          request.justification,
        ],
      );

      await this.audit(client, {
        actor: request.owner,
        action: 'placed_legal_hold',
        subjectType: request.subjectType,
        subjectId: request.subjectId,
        caseId: request.caseId,
        justification: request.justification,
      });

      return { holdId, applied: true };
    });
  }

  /**
   * Release a hold and restore the normal expiry.
   *
   * The flag is only cleared when **no other open hold** covers the same
   * subject: two cases can hold the same conversation, and releasing one must
   * not free data the other still needs. The released row is kept — the record
   * that something was held, by whom and why, outlives the hold.
   */
  async release(holdId: string, releasedBy: string, justification: string): Promise<boolean> {
    return this.db.transaction(async (client) => {
      const held = await client.query(
        `update legal_holds
            set released_at = now(), released_by = $2
          where hold_id = $1 and released_at is null
          returning subject_type, subject_id, case_id`,
        [holdId, releasedBy],
      );
      const row = held.rows[0] as
        | { subject_type: HoldSubject; subject_id: string; case_id: string }
        | undefined;
      if (!row) return false;

      const target = TABLE[row.subject_type];
      const remaining = await client.query(
        `select 1 from legal_holds
          where subject_type = $1 and subject_id = $2 and released_at is null
          limit 1`,
        [row.subject_type, row.subject_id],
      );
      if ((remaining.rowCount ?? 0) === 0) {
        await client.query(
          `update ${target.table} set legal_hold = false where ${target.key} = $1`,
          [row.subject_id],
        );
      }

      await this.audit(client, {
        actor: releasedBy,
        action: 'released_legal_hold',
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        caseId: row.case_id,
        justification,
      });

      return true;
    });
  }

  /** Open holds on one subject. */
  async active(subjectType: HoldSubject, subjectId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `select count(*)::text from legal_holds
        where subject_type = $1 and subject_id = $2 and released_at is null`,
      [subjectType, subjectId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  private async audit(
    client: SqlExecutor,
    entry: {
      actor: string;
      action: string;
      subjectType: string;
      subjectId: string;
      caseId: string;
      justification: string;
    },
  ): Promise<void> {
    await client.query(
      `insert into admin_audit
         (audit_id, actor, role, action, subject_type, subject_id, case_id,
          justification, created_at, retention_expires_at)
       values ($1, $2, 'operator', $3, $4, $5, $6, $7, now(), now() + interval '365 days')`,
      [
        randomUUID(),
        entry.actor,
        entry.action,
        entry.subjectType,
        entry.subjectId,
        entry.caseId,
        entry.justification,
      ],
    );
  }
}
