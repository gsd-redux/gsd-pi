// Project/App: gsd-pi
// File Purpose: Additive v33 guided-conversation and durable checkpoint schema.

import type { DbAdapter } from "./db-adapter.js";

/**
 * The v33 tables are canonical conversation facts, but no runtime flow reads
 * them yet. Existing prompts, files, and caches retain their current behavior
 * until the later cutover migration. V33 validates individual facts and
 * transitions; later command writers must use the S06 Domain Operation
 * boundary to commit each question or answer/decision/impact/checkpoint bundle
 * atomically.
 */
export function createConversationFoundationSchemaV33(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_milestone_contexts (
      context_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      lifecycle_id TEXT NOT NULL,
      milestone_id TEXT NOT NULL,
      milestone_kind TEXT NOT NULL CHECK (
        milestone_kind IN ('discovery', 'research', 'requirements', 'roadmap', 'delivery', 'remediation')
      ),
      planned_start_at TEXT DEFAULT NULL,
      planned_end_at TEXT DEFAULT NULL,
      review_at TEXT DEFAULT NULL,
      horizon_note TEXT NOT NULL DEFAULT '',
      supersedes_context_id TEXT DEFAULT NULL UNIQUE,
      created_at TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      project_revision INTEGER NOT NULL CHECK (project_revision > 0),
      authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
      UNIQUE (context_id, project_id, lifecycle_id, milestone_id),
      FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
      FOREIGN KEY (lifecycle_id, project_id)
        REFERENCES workflow_item_lifecycles(lifecycle_id, project_id),
      FOREIGN KEY (operation_id, project_id, project_revision, authority_epoch)
        REFERENCES workflow_operations(
          operation_id, project_id, resulting_revision, resulting_authority_epoch
        ),
      FOREIGN KEY (supersedes_context_id) REFERENCES workflow_milestone_contexts(context_id)
    );

    CREATE TRIGGER IF NOT EXISTS trg_workflow_milestone_context_scope
    BEFORE INSERT ON workflow_milestone_contexts
    WHEN (NEW.supersedes_context_id IS NULL AND EXISTS (
      SELECT 1 FROM workflow_milestone_contexts existing
      WHERE existing.project_id = NEW.project_id
        AND existing.lifecycle_id = NEW.lifecycle_id
        AND existing.milestone_id = NEW.milestone_id
    )) OR NOT EXISTS (
      SELECT 1 FROM workflow_item_lifecycles lifecycle
      WHERE lifecycle.lifecycle_id = NEW.lifecycle_id
        AND lifecycle.project_id = NEW.project_id
        AND lifecycle.item_kind = 'milestone'
        AND lifecycle.milestone_id = NEW.milestone_id
    ) OR (
      NEW.supersedes_context_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workflow_milestone_contexts previous
        WHERE previous.context_id = NEW.supersedes_context_id
          AND previous.project_id = NEW.project_id
          AND previous.lifecycle_id = NEW.lifecycle_id
          AND previous.milestone_id = NEW.milestone_id
          AND previous.project_revision < NEW.project_revision
          AND previous.authority_epoch <= NEW.authority_epoch
          AND NOT EXISTS (
            SELECT 1 FROM workflow_milestone_contexts successor
            WHERE successor.supersedes_context_id = previous.context_id
          )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'milestone context must match scope and supersede the current head');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_milestone_context_immutable_update
    BEFORE UPDATE ON workflow_milestone_contexts
    BEGIN
      SELECT RAISE(ABORT, 'milestone contexts are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_workflow_milestone_context_immutable_delete
    BEFORE DELETE ON workflow_milestone_contexts
    BEGIN
      SELECT RAISE(ABORT, 'milestone contexts are immutable');
    END;

    CREATE TABLE IF NOT EXISTS workflow_open_questions (
      question_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      lifecycle_id TEXT NOT NULL,
      question_text TEXT NOT NULL CHECK (length(trim(question_text)) > 0),
      question_status TEXT NOT NULL CHECK (question_status IN ('open', 'answered', 'withdrawn')),
      state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
      accepted_answer_id TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_operation_id TEXT NOT NULL,
      created_project_revision INTEGER NOT NULL CHECK (created_project_revision > 0),
      created_authority_epoch INTEGER NOT NULL CHECK (created_authority_epoch >= 0),
      last_operation_id TEXT NOT NULL,
      last_project_revision INTEGER NOT NULL CHECK (last_project_revision > 0),
      last_authority_epoch INTEGER NOT NULL CHECK (last_authority_epoch >= 0),
      UNIQUE (question_id, project_id),
      UNIQUE (question_id, project_id, lifecycle_id),
      CHECK (
        (question_status = 'answered' AND accepted_answer_id IS NOT NULL) OR
        (question_status != 'answered' AND accepted_answer_id IS NULL)
      ),
      CHECK (last_project_revision >= created_project_revision),
      CHECK (last_authority_epoch >= created_authority_epoch),
      FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
      FOREIGN KEY (lifecycle_id, project_id)
        REFERENCES workflow_item_lifecycles(lifecycle_id, project_id),
      FOREIGN KEY (
        created_operation_id, project_id, created_project_revision, created_authority_epoch
      ) REFERENCES workflow_operations(
        operation_id, project_id, resulting_revision, resulting_authority_epoch
      ),
      FOREIGN KEY (
        last_operation_id, project_id, last_project_revision, last_authority_epoch
      ) REFERENCES workflow_operations(
        operation_id, project_id, resulting_revision, resulting_authority_epoch
      )
    );

    CREATE TABLE IF NOT EXISTS workflow_question_dependencies (
      question_id TEXT NOT NULL,
      lifecycle_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      dependency_kind TEXT NOT NULL DEFAULT 'revalidate' CHECK (
        dependency_kind IN ('inform', 'revalidate')
      ),
      created_at TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      project_revision INTEGER NOT NULL CHECK (project_revision > 0),
      authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
      PRIMARY KEY (question_id, lifecycle_id),
      FOREIGN KEY (question_id, project_id)
        REFERENCES workflow_open_questions(question_id, project_id),
      FOREIGN KEY (lifecycle_id, project_id)
        REFERENCES workflow_item_lifecycles(lifecycle_id, project_id),
      FOREIGN KEY (operation_id, project_id, project_revision, authority_epoch)
        REFERENCES workflow_operations(
          operation_id, project_id, resulting_revision, resulting_authority_epoch
        )
    );

    CREATE TRIGGER IF NOT EXISTS trg_workflow_question_dependency_immutable_update
    BEFORE UPDATE ON workflow_question_dependencies
    BEGIN
      SELECT RAISE(ABORT, 'question dependencies are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_workflow_question_dependency_immutable_delete
    BEFORE DELETE ON workflow_question_dependencies
    BEGIN
      SELECT RAISE(ABORT, 'question dependencies are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_question_initial_state
    BEFORE INSERT ON workflow_open_questions
    WHEN NEW.question_status != 'open'
      OR NEW.state_version != 0
      OR NEW.accepted_answer_id IS NOT NULL
      OR NEW.created_operation_id != NEW.last_operation_id
      OR NEW.created_project_revision != NEW.last_project_revision
      OR NEW.created_authority_epoch != NEW.last_authority_epoch
      OR NEW.created_at != NEW.updated_at
    BEGIN
      SELECT RAISE(ABORT, 'question must begin open at its creation provenance');
    END;

    CREATE TABLE IF NOT EXISTS workflow_interactions (
      interaction_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      interaction_kind TEXT NOT NULL CHECK (
        interaction_kind IN ('open', 'choice', 'clarification', 'recap', 'consent', 'subjective-uat')
      ),
      presentation_state TEXT NOT NULL CHECK (presentation_state IN ('prepared', 'presented')),
      focused_prompt TEXT NOT NULL CHECK (length(trim(focused_prompt)) > 0),
      requires_answer INTEGER NOT NULL CHECK (requires_answer IN (0, 1)),
      option_count INTEGER NOT NULL DEFAULT 0 CHECK (option_count BETWEEN 0 AND 3),
      recommended_option_id TEXT DEFAULT NULL,
      recommendation_text TEXT NOT NULL DEFAULT '',
      recommendation_rationale TEXT NOT NULL DEFAULT '',
      recommendation_evidence TEXT NOT NULL DEFAULT '',
      recommendation_confidence REAL DEFAULT NULL CHECK (
        recommendation_confidence IS NULL OR
        (recommendation_confidence >= 0 AND recommendation_confidence <= 1)
      ),
      recommendation_uncertainty TEXT NOT NULL DEFAULT '',
      revisit_condition TEXT NOT NULL DEFAULT '',
      presented_at TEXT NOT NULL DEFAULT '',
      operation_id TEXT NOT NULL,
      project_revision INTEGER NOT NULL CHECK (project_revision > 0),
      authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
      UNIQUE (question_id, sequence),
      UNIQUE (interaction_id, project_id),
      UNIQUE (interaction_id, question_id, project_id),
      UNIQUE (interaction_id, project_id, operation_id, project_revision, authority_epoch),
      CHECK (
        (interaction_kind = 'recap' AND requires_answer = 0) OR
        (interaction_kind != 'recap' AND requires_answer = 1)
      ),
      CHECK (
        requires_answer = 0 OR
        (length(trim(recommendation_text)) > 0 AND length(trim(recommendation_rationale)) > 0)
      ),
      FOREIGN KEY (question_id, project_id)
        REFERENCES workflow_open_questions(question_id, project_id),
      FOREIGN KEY (operation_id, project_id, project_revision, authority_epoch)
        REFERENCES workflow_operations(
          operation_id, project_id, resulting_revision, resulting_authority_epoch
        )
    );

    CREATE TABLE IF NOT EXISTS workflow_interaction_options (
      interaction_id TEXT NOT NULL,
      option_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 3),
      label TEXT NOT NULL CHECK (length(trim(label)) > 0),
      description TEXT NOT NULL DEFAULT '',
      operation_id TEXT NOT NULL,
      project_revision INTEGER NOT NULL CHECK (project_revision > 0),
      authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
      PRIMARY KEY (interaction_id, option_id),
      UNIQUE (interaction_id, ordinal),
      UNIQUE (interaction_id, option_id, project_id),
      FOREIGN KEY (interaction_id, project_id, operation_id, project_revision, authority_epoch)
        REFERENCES workflow_interactions(
          interaction_id, project_id, operation_id, project_revision, authority_epoch
        )
    );

    CREATE TRIGGER IF NOT EXISTS trg_workflow_interaction_initial_state
    BEFORE INSERT ON workflow_interactions
    WHEN NEW.presentation_state != 'prepared'
    BEGIN
      SELECT RAISE(ABORT, 'interaction must begin prepared');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_interaction_option_prepared
    BEFORE INSERT ON workflow_interaction_options
    WHEN NOT EXISTS (
      SELECT 1 FROM workflow_interactions interaction
      WHERE interaction.interaction_id = NEW.interaction_id
        AND interaction.project_id = NEW.project_id
        AND interaction.presentation_state = 'prepared'
    )
    BEGIN
      SELECT RAISE(ABORT, 'options may only be added while interaction is prepared');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_interaction_present
    BEFORE UPDATE OF presentation_state ON workflow_interactions
    WHEN NEW.presentation_state = 'presented' AND (
      OLD.presentation_state != 'prepared' OR
      NEW.interaction_id != OLD.interaction_id OR
      NEW.project_id != OLD.project_id OR
      NEW.question_id != OLD.question_id OR
      NEW.sequence != OLD.sequence OR
      NEW.interaction_kind != OLD.interaction_kind OR
      NEW.focused_prompt != OLD.focused_prompt OR
      NEW.requires_answer != OLD.requires_answer OR
      NEW.option_count != OLD.option_count OR
      NEW.recommended_option_id IS NOT OLD.recommended_option_id OR
      NEW.recommendation_text != OLD.recommendation_text OR
      NEW.recommendation_rationale != OLD.recommendation_rationale OR
      NEW.recommendation_evidence != OLD.recommendation_evidence OR
      NEW.recommendation_confidence IS NOT OLD.recommendation_confidence OR
      NEW.recommendation_uncertainty != OLD.recommendation_uncertainty OR
      NEW.revisit_condition != OLD.revisit_condition OR
      NEW.operation_id != OLD.operation_id OR
      NEW.project_revision != OLD.project_revision OR
      NEW.authority_epoch != OLD.authority_epoch OR
      (NEW.interaction_kind = 'choice' AND NEW.option_count NOT BETWEEN 2 AND 3) OR
      (SELECT COUNT(*) FROM workflow_interaction_options option
        WHERE option.interaction_id = NEW.interaction_id) != NEW.option_count OR
      (NEW.recommended_option_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workflow_interaction_options option
        WHERE option.interaction_id = NEW.interaction_id
          AND option.option_id = NEW.recommended_option_id
          AND option.ordinal = 1
      )) OR
      (NEW.option_count > 0 AND NEW.recommended_option_id IS NULL)
    )
    BEGIN
      SELECT RAISE(ABORT, 'presented interaction is invalid; recommended option must be first');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_interaction_immutable_update
    BEFORE UPDATE ON workflow_interactions
    WHEN NOT (OLD.presentation_state = 'prepared' AND NEW.presentation_state = 'presented')
    BEGIN
      SELECT RAISE(ABORT, 'presented interactions are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_workflow_interaction_immutable_delete
    BEFORE DELETE ON workflow_interactions
    BEGIN
      SELECT RAISE(ABORT, 'interactions are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_workflow_interaction_option_immutable_update
    BEFORE UPDATE ON workflow_interaction_options
    BEGIN
      SELECT RAISE(ABORT, 'interaction options are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_workflow_interaction_option_immutable_delete
    BEFORE DELETE ON workflow_interaction_options
    BEGIN
      SELECT RAISE(ABORT, 'interaction options are immutable');
    END;

    CREATE TABLE IF NOT EXISTS workflow_answers (
      answer_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      interaction_id TEXT NOT NULL,
      response_kind TEXT NOT NULL CHECK (
        response_kind IN ('answer', 'pushback', 'correction', 'clarification', 'consent')
      ),
      verbatim_response TEXT NOT NULL CHECK (length(verbatim_response) > 0),
      selected_option_id TEXT DEFAULT NULL,
      normalized_interpretation TEXT NOT NULL CHECK (length(trim(normalized_interpretation)) > 0),
      interpretation_confidence REAL NOT NULL CHECK (
        interpretation_confidence >= 0 AND interpretation_confidence <= 1
      ),
      answer_disposition TEXT NOT NULL CHECK (
        answer_disposition IN ('accepted', 'revision-conflict')
      ),
      observed_project_revision INTEGER NOT NULL CHECK (observed_project_revision >= 0),
      created_at TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      project_revision INTEGER NOT NULL CHECK (project_revision > observed_project_revision),
      authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
      UNIQUE (answer_id, project_id),
      UNIQUE (answer_id, question_id, project_id),
      UNIQUE (answer_id, question_id, interaction_id, project_id),
      UNIQUE (answer_id, question_id, project_id, operation_id, project_revision, authority_epoch),
      FOREIGN KEY (question_id, project_id)
        REFERENCES workflow_open_questions(question_id, project_id),
      FOREIGN KEY (interaction_id, question_id, project_id)
        REFERENCES workflow_interactions(interaction_id, question_id, project_id),
      FOREIGN KEY (interaction_id, selected_option_id, project_id)
        REFERENCES workflow_interaction_options(interaction_id, option_id, project_id),
      FOREIGN KEY (operation_id, project_id, project_revision, authority_epoch)
        REFERENCES workflow_operations(
          operation_id, project_id, resulting_revision, resulting_authority_epoch
        )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_answer_accepted
    ON workflow_answers(interaction_id)
    WHERE answer_disposition = 'accepted';

    CREATE TRIGGER IF NOT EXISTS trg_workflow_answer_acceptance
    BEFORE INSERT ON workflow_answers
    WHEN NEW.answer_disposition = 'accepted' AND NOT EXISTS (
      SELECT 1 FROM workflow_interactions interaction
      WHERE interaction.interaction_id = NEW.interaction_id
        AND interaction.question_id = NEW.question_id
        AND interaction.project_id = NEW.project_id
        AND interaction.presentation_state = 'presented'
        AND (
          interaction.requires_answer = 1 OR
          (interaction.interaction_kind = 'recap' AND NEW.response_kind = 'correction')
        )
        AND interaction.project_revision = NEW.observed_project_revision
        AND interaction.authority_epoch <= NEW.authority_epoch
    )
    BEGIN
      SELECT RAISE(ABORT, 'accepted answer must respond to the presented interaction');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_answer_immutable_update
    BEFORE UPDATE ON workflow_answers
    BEGIN
      SELECT RAISE(ABORT, 'answers are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_workflow_answer_immutable_delete
    BEFORE DELETE ON workflow_answers
    BEGIN
      SELECT RAISE(ABORT, 'answers are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_question_transition
    BEFORE UPDATE ON workflow_open_questions
    WHEN NEW.question_id != OLD.question_id
      OR NEW.project_id != OLD.project_id
      OR NEW.lifecycle_id != OLD.lifecycle_id
      OR NEW.question_text != OLD.question_text
      OR NEW.created_at != OLD.created_at
      OR NEW.created_operation_id != OLD.created_operation_id
      OR NEW.created_project_revision != OLD.created_project_revision
      OR NEW.created_authority_epoch != OLD.created_authority_epoch
      OR NEW.question_status = OLD.question_status
      OR NEW.state_version != OLD.state_version + 1
      OR NEW.last_project_revision <= OLD.last_project_revision
      OR NEW.last_authority_epoch < OLD.last_authority_epoch
      OR NEW.updated_at = OLD.updated_at
      OR NOT (
        (OLD.question_status = 'open' AND NEW.question_status IN ('answered', 'withdrawn'))
      )
      OR (NEW.question_status = 'answered' AND NOT EXISTS (
        SELECT 1 FROM workflow_answers answer
        WHERE answer.answer_id = NEW.accepted_answer_id
          AND answer.question_id = NEW.question_id
          AND answer.project_id = NEW.project_id
          AND answer.answer_disposition = 'accepted'
          AND answer.operation_id = NEW.last_operation_id
          AND answer.project_revision = NEW.last_project_revision
          AND answer.authority_epoch = NEW.last_authority_epoch
      ))
    BEGIN
      SELECT RAISE(ABORT, 'invalid open question transition');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_workflow_question_delete
    BEFORE DELETE ON workflow_open_questions
    BEGIN
      SELECT RAISE(ABORT, 'open questions are durable history');
    END;

    CREATE TABLE IF NOT EXISTS workflow_conversation_decisions (
      decision_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      answer_id TEXT NOT NULL,
      decision_text TEXT NOT NULL CHECK (length(trim(decision_text)) > 0),
      supersedes_decision_id TEXT DEFAULT NULL UNIQUE,
      created_at TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      project_revision INTEGER NOT NULL CHECK (project_revision > 0),
      authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
      UNIQUE (decision_id, project_id),
      UNIQUE (decision_id, project_id, operation_id, project_revision, authority_epoch),
      FOREIGN KEY (question_id, project_id)
        REFERENCES workflow_open_questions(question_id, project_id),
      FOREIGN KEY (
        answer_id, question_id, project_id, operation_id, project_revision, authority_epoch
      ) REFERENCES workflow_answers(
        answer_id, question_id, project_id, operation_id, project_revision, authority_epoch
      ),
      FOREIGN KEY (supersedes_decision_id) REFERENCES workflow_conversation_decisions(decision_id),
      FOREIGN KEY (operation_id, project_id, project_revision, authority_epoch)
        REFERENCES workflow_operations(
          operation_id, project_id, resulting_revision, resulting_authority_epoch
        )
    );

    CREATE TRIGGER IF NOT EXISTS trg_workflow_decision_supersession
    BEFORE INSERT ON workflow_conversation_decisions
    WHEN (NEW.supersedes_decision_id IS NULL AND EXISTS (
      SELECT 1 FROM workflow_conversation_decisions existing
      WHERE existing.project_id = NEW.project_id
        AND existing.question_id = NEW.question_id
    )) OR (NEW.supersedes_decision_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM workflow_conversation_decisions previous
      WHERE previous.decision_id = NEW.supersedes_decision_id
        AND previous.project_id = NEW.project_id
        AND previous.question_id = NEW.question_id
        AND previous.project_revision < NEW.project_revision
        AND previous.authority_epoch <= NEW.authority_epoch
        AND NOT EXISTS (
          SELECT 1 FROM workflow_conversation_decisions successor
          WHERE successor.supersedes_decision_id = previous.decision_id
        )
    ))
    BEGIN
      SELECT RAISE(ABORT, 'decision must supersede the current head');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_workflow_decision_accepted_answer
    BEFORE INSERT ON workflow_conversation_decisions
    WHEN NOT EXISTS (
      SELECT 1 FROM workflow_answers answer
      WHERE answer.answer_id = NEW.answer_id
        AND answer.question_id = NEW.question_id
        AND answer.project_id = NEW.project_id
        AND answer.operation_id = NEW.operation_id
        AND answer.project_revision = NEW.project_revision
        AND answer.authority_epoch = NEW.authority_epoch
        AND answer.answer_disposition = 'accepted'
    )
    BEGIN
      SELECT RAISE(ABORT, 'decision requires an accepted Answer');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_workflow_decision_correction
    BEFORE INSERT ON workflow_conversation_decisions
    WHEN NEW.supersedes_decision_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM workflow_answers answer
      WHERE answer.answer_id = NEW.answer_id
        AND answer.response_kind = 'correction'
    )
    BEGIN
      SELECT RAISE(ABORT, 'superseding decision requires a correction Answer');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_workflow_decision_immutable_update
    BEFORE UPDATE ON workflow_conversation_decisions
    BEGIN
      SELECT RAISE(ABORT, 'conversation decisions are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_workflow_decision_immutable_delete
    BEFORE DELETE ON workflow_conversation_decisions
    BEGIN
      SELECT RAISE(ABORT, 'conversation decisions are immutable');
    END;

    CREATE TABLE IF NOT EXISTS workflow_decision_impacts (
      decision_id TEXT NOT NULL,
      lifecycle_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      effect TEXT NOT NULL CHECK (effect IN ('revalidate', 'invalidate', 'inform')),
      operation_id TEXT NOT NULL,
      project_revision INTEGER NOT NULL CHECK (project_revision > 0),
      authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
      PRIMARY KEY (decision_id, lifecycle_id),
      FOREIGN KEY (decision_id, project_id, operation_id, project_revision, authority_epoch)
        REFERENCES workflow_conversation_decisions(
          decision_id, project_id, operation_id, project_revision, authority_epoch
        ),
      FOREIGN KEY (lifecycle_id, project_id)
        REFERENCES workflow_item_lifecycles(lifecycle_id, project_id)
    );

    CREATE TRIGGER IF NOT EXISTS trg_workflow_decision_impact_reachable
    BEFORE INSERT ON workflow_decision_impacts
    WHEN NOT EXISTS (
      SELECT 1
      FROM workflow_conversation_decisions decision
      JOIN workflow_question_dependencies dependency
        ON dependency.question_id = decision.question_id
       AND dependency.project_id = decision.project_id
       AND dependency.lifecycle_id = NEW.lifecycle_id
      WHERE decision.decision_id = NEW.decision_id
        AND decision.project_id = NEW.project_id
        AND (
          NEW.effect = 'inform' OR
          dependency.dependency_kind = 'revalidate'
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'decision impact must target dependency-reachable work');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_decision_impact_immutable_update
    BEFORE UPDATE ON workflow_decision_impacts
    BEGIN
      SELECT RAISE(ABORT, 'decision impacts are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_workflow_decision_impact_immutable_delete
    BEFORE DELETE ON workflow_decision_impacts
    BEGIN
      SELECT RAISE(ABORT, 'decision impacts are immutable');
    END;

    CREATE TABLE IF NOT EXISTS workflow_work_checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      lifecycle_id TEXT NOT NULL,
      checkpoint_kind TEXT NOT NULL CHECK (
        checkpoint_kind IN (
          'discovery', 'research', 'requirements', 'roadmap', 'delivery',
          'answer', 'pause', 'correction', 'recap', 'handoff'
        )
      ),
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      previous_checkpoint_id TEXT DEFAULT NULL UNIQUE,
      confirmed_context TEXT NOT NULL DEFAULT '',
      unresolved_summary TEXT NOT NULL DEFAULT '',
      evidence_summary TEXT NOT NULL DEFAULT '',
      suggested_next_action TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      project_revision INTEGER NOT NULL CHECK (project_revision > 0),
      authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
      UNIQUE (scope_key, sequence),
      FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
      FOREIGN KEY (lifecycle_id, project_id)
        REFERENCES workflow_item_lifecycles(lifecycle_id, project_id),
      FOREIGN KEY (previous_checkpoint_id) REFERENCES workflow_work_checkpoints(checkpoint_id),
      FOREIGN KEY (operation_id, project_id, project_revision, authority_epoch)
        REFERENCES workflow_operations(
          operation_id, project_id, resulting_revision, resulting_authority_epoch
        )
    );

    CREATE TRIGGER IF NOT EXISTS trg_workflow_checkpoint_chain
    BEFORE INSERT ON workflow_work_checkpoints
    WHEN (NEW.previous_checkpoint_id IS NULL AND NEW.sequence != 1) OR
      (NEW.previous_checkpoint_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workflow_work_checkpoints previous
        WHERE previous.checkpoint_id = NEW.previous_checkpoint_id
          AND previous.project_id = NEW.project_id
          AND previous.scope_key = NEW.scope_key
          AND previous.lifecycle_id = NEW.lifecycle_id
          AND NEW.sequence = previous.sequence + 1
          AND previous.project_revision < NEW.project_revision
          AND previous.authority_epoch <= NEW.authority_epoch
          AND NOT EXISTS (
            SELECT 1 FROM workflow_work_checkpoints successor
            WHERE successor.previous_checkpoint_id = previous.checkpoint_id
          )
      ))
    BEGIN
      SELECT RAISE(ABORT, 'checkpoint must extend the current head');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_workflow_checkpoint_immutable_update
    BEFORE UPDATE ON workflow_work_checkpoints
    BEGIN
      SELECT RAISE(ABORT, 'work checkpoints are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_workflow_checkpoint_immutable_delete
    BEFORE DELETE ON workflow_work_checkpoints
    BEGIN
      SELECT RAISE(ABORT, 'work checkpoints are immutable');
    END;

    CREATE INDEX IF NOT EXISTS idx_workflow_questions_open
      ON workflow_open_questions(project_id, lifecycle_id, question_status);
    CREATE INDEX IF NOT EXISTS idx_workflow_decision_impacts_lifecycle
      ON workflow_decision_impacts(lifecycle_id, effect);
    CREATE INDEX IF NOT EXISTS idx_workflow_checkpoints_scope
      ON workflow_work_checkpoints(project_id, scope_key, sequence);
  `);
}
