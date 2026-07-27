import { Injectable } from '@nestjs/common';
import { QueryResultRow } from 'pg';
import { DatabaseService } from '../../database/database.service';
import {
  EmailParserTemplateProposalDto,
  LearnedEmailTemplate,
} from './dto/email-transaction.dto';

export interface ActivateEmailParserTemplateInput {
  userId: string;
  senderAddress: string;
  fingerprint: string;
  proposal: EmailParserTemplateProposalDto;
}

interface EmailParserTemplateRow extends QueryResultRow {
  id: string | number;
  user_id: string | number;
  sender_address: string;
  fingerprint: string;
  rules: EmailParserTemplateProposalDto;
}

@Injectable()
export class EmailParserTemplateRepository {
  constructor(private readonly database: DatabaseService) {}

  async findActive(
    userId: string,
    senderAddress: string,
  ): Promise<LearnedEmailTemplate[]> {
    const result = await this.database.query<EmailParserTemplateRow>(
      `
        SELECT id, user_id, sender_address, fingerprint, rules
        FROM email_parser_templates
        WHERE user_id = $1
          AND lower(sender_address) = lower($2)
          AND status = 'active'
        ORDER BY updated_at DESC
      `,
      [userId, senderAddress],
    );

    return result.rows.map((row) => this.mapRow(row));
  }

  async activate(
    input: ActivateEmailParserTemplateInput,
  ): Promise<LearnedEmailTemplate> {
    const result = await this.database.query<EmailParserTemplateRow>(
      `
        INSERT INTO email_parser_templates (
          user_id,
          provider,
          sender_address,
          template_key,
          fingerprint,
          rules
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        ON CONFLICT (user_id, fingerprint) DO UPDATE
        SET provider = EXCLUDED.provider,
            sender_address = EXCLUDED.sender_address,
            template_key = EXCLUDED.template_key,
            rules = EXCLUDED.rules,
            status = 'active',
            disabled_at = NULL,
            updated_at = now()
        RETURNING id, user_id, sender_address, fingerprint, rules
      `,
      [
        input.userId,
        input.proposal.provider,
        input.senderAddress,
        input.proposal.templateKey,
        input.fingerprint,
        JSON.stringify(input.proposal),
      ],
    );

    return this.mapRow(result.rows[0]);
  }

  async markMatched(templateId: string, userId: string): Promise<void> {
    await this.database.query(
      `
        UPDATE email_parser_templates
        SET last_matched_at = now(),
            updated_at = now()
        WHERE id = $1
          AND user_id = $2
      `,
      [templateId, userId],
    );
  }

  async disable(templateId: string, userId: string): Promise<void> {
    await this.database.query(
      `
        UPDATE email_parser_templates
        SET status = 'disabled',
            disabled_at = now(),
            updated_at = now()
        WHERE id = $1
          AND user_id = $2
      `,
      [templateId, userId],
    );
  }

  private mapRow(row: EmailParserTemplateRow): LearnedEmailTemplate {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      senderAddress: row.sender_address,
      fingerprint: row.fingerprint,
      proposal: row.rules,
    };
  }
}
