// Project/App: gsd-pi
// File Purpose: Additive v34 recovery, verification, acceptance, and remediation schema.

import type { DbAdapter } from "./db-adapter.js";

/**
 * V34 records durable recovery allocations and immutable proof facts without
 * cutting runtime readers or writers over to them. S06 Domain Operations must
 * atomically commit failure/action and verdict/evidence bundles, plus any
 * applicable remediation links, and must enforce bundle completeness before
 * dispatch or lifecycle closeout.
 */
export function createRecoveryEvidenceFoundationSchemaV34(db: DbAdapter): void {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_attempt_scope_v34
      ON workflow_execution_attempts(attempt_id, lifecycle_id, project_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_result_scope_v34
      ON workflow_attempt_results(result_id, attempt_id, lifecycle_id, project_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_blocker_scope_v34
      ON workflow_blockers(blocker_id, lifecycle_id, project_id);

    CREATE TABLE IF NOT EXISTS workflow_failure_observations (
      failure_observation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      lifecycle_id TEXT NOT NULL,
      attempt_id TEXT DEFAULT NULL,
      result_id TEXT DEFAULT NULL,
      blocker_id TEXT DEFAULT NULL,
      recovery_owner TEXT NOT NULL CHECK (recovery_owner IN ('agent', 'user', 'external')),
      boundary_stage TEXT NOT NULL CHECK (
        boundary_stage IN ('advance', 'execute', 'verify', 'route', 'closeout')
      ),
      failure_kind TEXT NOT NULL CHECK (
        length(trim(failure_kind)) > 0 AND failure_kind = lower(trim(failure_kind))
      ),
      failure_fingerprint TEXT NOT NULL CHECK (
        length(trim(failure_fingerprint)) > 0 AND
        failure_fingerprint = lower(trim(failure_fingerprint))
      ),
      summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
      evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json)),
      observed_at TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      project_revision INTEGER NOT NULL CHECK (project_revision > 0),
      authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
      UNIQUE (failure_observation_id, project_id, lifecycle_id),
      CHECK (result_id IS NULL OR attempt_id IS NOT NULL),
      CHECK (
        (recovery_owner = 'agent' AND blocker_id IS NULL) OR
        (recovery_owner IN ('user', 'external') AND blocker_id IS NOT NULL)
      ),
      CHECK (
        (boundary_stage = 'execute' AND attempt_id IS NOT NULL AND result_id IS NOT NULL) OR
        boundary_stage != 'execute'
      ),
      FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
      FOREIGN KEY (lifecycle_id, project_id)
        REFERENCES workflow_item_lifecycles(lifecycle_id, project_id),
      FOREIGN KEY (attempt_id, lifecycle_id, project_id)
        REFERENCES workflow_execution_attempts(attempt_id, lifecycle_id, project_id),
      FOREIGN KEY (result_id, attempt_id, lifecycle_id, project_id)
        REFERENCES workflow_attempt_results(result_id, attempt_id, lifecycle_id, project_id),
      FOREIGN KEY (blocker_id, lifecycle_id, project_id)
        REFERENCES workflow_blockers(blocker_id, lifecycle_id, project_id),
      FOREIGN KEY (operation_id, project_id, project_revision, authority_epoch)
        REFERENCES workflow_operations(
          operation_id, project_id, resulting_revision, resulting_authority_epoch
        )
    );

    CREATE TRIGGER IF NOT EXISTS trg_workflow_failure_result_scope
    BEFORE INSERT ON workflow_failure_observations
    WHEN NEW.result_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM workflow_attempt_results result
      JOIN workflow_execution_attempts attempt ON attempt.attempt_id = result.attempt_id
      WHERE result.result_id = NEW.result_id
        AND result.project_id = NEW.project_id
        AND result.lifecycle_id = NEW.lifecycle_id
        AND result.attempt_id = NEW.attempt_id
        AND result.outcome IN ('failed', 'interrupted')
        AND result.project_revision < NEW.project_revision
        AND result.authority_epoch <= NEW.authority_epoch
        AND attempt.lifecycle_id = NEW.lifecycle_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'failure observation requires a matching failed or interrupted result');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_failure_recovery_owner
    BEFORE INSERT ON workflow_failure_observations
    WHEN NEW.recovery_owner IN ('user', 'external') AND NOT EXISTS (
      SELECT 1 FROM workflow_blockers blocker
      WHERE blocker.blocker_id = NEW.blocker_id
        AND blocker.project_id = NEW.project_id
        AND blocker.lifecycle_id = NEW.lifecycle_id
        AND blocker.resolution_owner = NEW.recovery_owner
        AND blocker.blocker_status = 'open'
        AND blocker.opened_project_revision <= NEW.project_revision
        AND blocker.opened_authority_epoch <= NEW.authority_epoch
        AND blocker.blocker_kind IN (
          'missing_authority', 'missing_access', 'external_dependency', 'consent',
          'ambiguous_intent', 'subjective_uat', 'user_limit'
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'human recovery owner requires its matching open blocker');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_failure_immutable_update
    BEFORE UPDATE ON workflow_failure_observations
    BEGIN
      SELECT RAISE(ABORT, 'failure observations are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_workflow_failure_immutable_delete
    BEFORE DELETE ON workflow_failure_observations
    BEGIN
      SELECT RAISE(ABORT, 'failure observations are immutable durable history');
    END;

    CREATE TABLE IF NOT EXISTS workflow_recovery_budgets (
      recovery_budget_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      lifecycle_id TEXT NOT NULL,
      failure_kind TEXT NOT NULL CHECK (
        length(trim(failure_kind)) > 0 AND failure_kind = lower(trim(failure_kind))
      ),
      failure_fingerprint TEXT NOT NULL CHECK (
        length(trim(failure_fingerprint)) > 0 AND
        failure_fingerprint = lower(trim(failure_fingerprint))
      ),
      policy_class TEXT NOT NULL CHECK (policy_class IN (
        'transient-execution', 'deterministic-repair', 'schema-correction',
        'remediation', 'objective-uat'
      )),
      max_uses INTEGER NOT NULL CHECK (
        max_uses > 0 AND max_uses <= CASE policy_class
          WHEN 'deterministic-repair' THEN 1
          ELSE 2
        END
      ),
      policy_version TEXT NOT NULL CHECK (length(trim(policy_version)) > 0),
      created_at TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      project_revision INTEGER NOT NULL CHECK (project_revision > 0),
      authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
      UNIQUE (
        project_id, lifecycle_id, failure_kind, failure_fingerprint,
        policy_class
      ),
      UNIQUE (recovery_budget_id, project_id, lifecycle_id),
      FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
      FOREIGN KEY (lifecycle_id, project_id)
        REFERENCES workflow_item_lifecycles(lifecycle_id, project_id),
      FOREIGN KEY (operation_id, project_id, project_revision, authority_epoch)
        REFERENCES workflow_operations(
          operation_id, project_id, resulting_revision, resulting_authority_epoch
        )
    );

    CREATE TRIGGER IF NOT EXISTS trg_workflow_recovery_budget_immutable_update
    BEFORE UPDATE ON workflow_recovery_budgets
    BEGIN
      SELECT RAISE(ABORT, 'recovery budgets are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_workflow_recovery_budget_immutable_delete
    BEFORE DELETE ON workflow_recovery_budgets
    BEGIN
      SELECT RAISE(ABORT, 'recovery budgets are immutable');
    END;

    CREATE TABLE IF NOT EXISTS workflow_recovery_actions (
      recovery_action_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      lifecycle_id TEXT NOT NULL,
      failure_observation_id TEXT NOT NULL UNIQUE,
      action TEXT NOT NULL CHECK (
        action IN ('retry', 'repair', 'replan', 'remediate', 'clarify', 'pause', 'abort')
      ),
      recovery_budget_id TEXT DEFAULT NULL,
      target_lifecycle_id TEXT DEFAULT NULL,
      blocker_id TEXT DEFAULT NULL,
      rationale TEXT NOT NULL CHECK (length(trim(rationale)) > 0),
      policy_version TEXT NOT NULL CHECK (length(trim(policy_version)) > 0),
      selected_at TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      project_revision INTEGER NOT NULL CHECK (project_revision > 0),
      authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
      CHECK (
        (action = 'retry' AND recovery_budget_id IS NOT NULL
          AND target_lifecycle_id IS NOT NULL
          AND target_lifecycle_id = lifecycle_id AND blocker_id IS NULL) OR
        (action IN ('repair', 'remediate') AND recovery_budget_id IS NOT NULL
          AND target_lifecycle_id IS NOT NULL AND blocker_id IS NULL) OR
        (action = 'replan' AND recovery_budget_id IS NULL
          AND target_lifecycle_id IS NOT NULL AND blocker_id IS NULL) OR
        (action IN ('clarify', 'pause') AND recovery_budget_id IS NULL
          AND target_lifecycle_id IS NULL AND blocker_id IS NOT NULL) OR
        (action = 'abort' AND recovery_budget_id IS NULL
          AND target_lifecycle_id IS NULL AND blocker_id IS NULL)
      ),
      UNIQUE (recovery_action_id, project_id, lifecycle_id),
      FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
      FOREIGN KEY (lifecycle_id, project_id)
        REFERENCES workflow_item_lifecycles(lifecycle_id, project_id),
      FOREIGN KEY (failure_observation_id, project_id, lifecycle_id)
        REFERENCES workflow_failure_observations(
          failure_observation_id, project_id, lifecycle_id
        ),
      FOREIGN KEY (recovery_budget_id, project_id, lifecycle_id)
        REFERENCES workflow_recovery_budgets(recovery_budget_id, project_id, lifecycle_id),
      FOREIGN KEY (target_lifecycle_id, project_id)
        REFERENCES workflow_item_lifecycles(lifecycle_id, project_id),
      FOREIGN KEY (blocker_id, lifecycle_id, project_id)
        REFERENCES workflow_blockers(blocker_id, lifecycle_id, project_id),
      FOREIGN KEY (operation_id, project_id, project_revision, authority_epoch)
        REFERENCES workflow_operations(
          operation_id, project_id, resulting_revision, resulting_authority_epoch
        )
    );

    CREATE TRIGGER IF NOT EXISTS trg_workflow_recovery_action_scope
    BEFORE INSERT ON workflow_recovery_actions
    WHEN NOT EXISTS (
      SELECT 1 FROM workflow_failure_observations failure
      WHERE failure.failure_observation_id = NEW.failure_observation_id
        AND failure.project_id = NEW.project_id
        AND failure.lifecycle_id = NEW.lifecycle_id
        AND failure.project_revision <= NEW.project_revision
        AND failure.authority_epoch <= NEW.authority_epoch
    )
    BEGIN
      SELECT RAISE(ABORT, 'recovery action must follow its failure observation');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_recovery_action_budget
    BEFORE INSERT ON workflow_recovery_actions
    WHEN NEW.recovery_budget_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM workflow_recovery_actions routed
        WHERE routed.failure_observation_id = NEW.failure_observation_id
      )
      AND NOT EXISTS (
      SELECT 1 FROM workflow_recovery_budgets budget
      JOIN workflow_failure_observations failure
        ON failure.failure_observation_id = NEW.failure_observation_id
      WHERE budget.recovery_budget_id = NEW.recovery_budget_id
        AND budget.project_id = NEW.project_id
        AND budget.lifecycle_id = NEW.lifecycle_id
        AND budget.failure_kind = failure.failure_kind
        AND budget.failure_fingerprint = failure.failure_fingerprint
        AND budget.policy_version = NEW.policy_version
        AND budget.project_revision <= NEW.project_revision
        AND budget.authority_epoch <= NEW.authority_epoch
        AND (
          (NEW.action = 'retry' AND budget.policy_class IN (
            'transient-execution', 'schema-correction', 'objective-uat'
          )) OR
          (NEW.action = 'repair' AND budget.policy_class IN (
            'deterministic-repair', 'schema-correction'
          )) OR
          (NEW.action = 'remediate' AND budget.policy_class = 'remediation')
        )
        AND (
          SELECT COUNT(*) FROM workflow_recovery_actions used
          WHERE used.recovery_budget_id = budget.recovery_budget_id
        ) < budget.max_uses
    )
    BEGIN
      SELECT RAISE(ABORT, 'recovery budget is exhausted or does not match the failure');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_recovery_action_remediation_target
    BEFORE INSERT ON workflow_recovery_actions
    WHEN NEW.action = 'remediate' AND NOT EXISTS (
      SELECT 1 FROM workflow_item_lifecycles target
      WHERE target.lifecycle_id = NEW.target_lifecycle_id
        AND target.project_id = NEW.project_id
        AND target.item_kind = 'task'
        AND target.lifecycle_status NOT IN ('completed', 'cancelled')
    )
    BEGIN
      SELECT RAISE(ABORT, 'remediation recovery must target actionable task work');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_recovery_action_blocker
    BEFORE INSERT ON workflow_recovery_actions
    WHEN NEW.action IN ('clarify', 'pause') AND NOT EXISTS (
      SELECT 1
      FROM workflow_blockers blocker
      JOIN workflow_failure_observations failure
        ON failure.failure_observation_id = NEW.failure_observation_id
        AND failure.project_id = blocker.project_id
        AND failure.lifecycle_id = blocker.lifecycle_id
        AND failure.blocker_id = blocker.blocker_id
        AND failure.recovery_owner = blocker.resolution_owner
        AND failure.recovery_owner IN ('user', 'external')
      WHERE blocker.blocker_id = NEW.blocker_id
        AND blocker.project_id = NEW.project_id
        AND blocker.lifecycle_id = NEW.lifecycle_id
        AND blocker.blocker_status = 'open'
        AND blocker.opened_project_revision <= NEW.project_revision
        AND blocker.opened_authority_epoch <= NEW.authority_epoch
        AND blocker.blocker_kind IN (
          'missing_authority', 'missing_access', 'external_dependency', 'consent',
          'ambiguous_intent', 'subjective_uat', 'user_limit'
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'clarify or pause requires an open human blocker');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_recovery_action_immutable_update
    BEFORE UPDATE ON workflow_recovery_actions
    BEGIN
      SELECT RAISE(ABORT, 'recovery actions are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_workflow_recovery_action_immutable_delete
    BEFORE DELETE ON workflow_recovery_actions
    BEGIN
      SELECT RAISE(ABORT, 'recovery actions are immutable');
    END;

    CREATE TABLE IF NOT EXISTS workflow_acceptance_criteria (
      criterion_id TEXT PRIMARY KEY,
      criterion_key TEXT NOT NULL CHECK (
        length(trim(criterion_key)) > 0 AND criterion_key = lower(trim(criterion_key))
      ),
      project_id TEXT NOT NULL,
      lifecycle_id TEXT NOT NULL,
      requirement_id TEXT DEFAULT NULL,
      criterion_kind TEXT NOT NULL CHECK (criterion_kind IN ('technical', 'subjective_uat')),
      evidence_class TEXT NOT NULL CHECK (
        evidence_class IN ('command', 'runtime', 'browser', 'artifact', 'human')
      ),
      required INTEGER NOT NULL CHECK (required IN (0, 1)),
      description TEXT NOT NULL CHECK (length(trim(description)) > 0),
      supersedes_criterion_id TEXT DEFAULT NULL UNIQUE,
      created_at TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      project_revision INTEGER NOT NULL CHECK (project_revision > 0),
      authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
      UNIQUE (criterion_id, project_id, lifecycle_id),
      CHECK (
        (criterion_kind = 'technical' AND evidence_class != 'human') OR
        (criterion_kind = 'subjective_uat' AND evidence_class = 'human')
      ),
      FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
      FOREIGN KEY (lifecycle_id, project_id)
        REFERENCES workflow_item_lifecycles(lifecycle_id, project_id),
      FOREIGN KEY (requirement_id) REFERENCES requirements(id),
      FOREIGN KEY (supersedes_criterion_id)
        REFERENCES workflow_acceptance_criteria(criterion_id),
      FOREIGN KEY (operation_id, project_id, project_revision, authority_epoch)
        REFERENCES workflow_operations(
          operation_id, project_id, resulting_revision, resulting_authority_epoch
        )
    );

    CREATE TRIGGER IF NOT EXISTS trg_workflow_criterion_supersession
    BEFORE INSERT ON workflow_acceptance_criteria
    WHEN (NEW.supersedes_criterion_id IS NULL AND EXISTS (
      SELECT 1 FROM workflow_acceptance_criteria existing
      WHERE existing.project_id = NEW.project_id
        AND existing.lifecycle_id = NEW.lifecycle_id
        AND existing.criterion_key = NEW.criterion_key
        AND existing.requirement_id IS NEW.requirement_id
    )) OR (NEW.supersedes_criterion_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM workflow_acceptance_criteria previous
      WHERE previous.criterion_id = NEW.supersedes_criterion_id
        AND previous.project_id = NEW.project_id
        AND previous.lifecycle_id = NEW.lifecycle_id
        AND previous.criterion_key = NEW.criterion_key
        AND previous.requirement_id IS NEW.requirement_id
        AND previous.criterion_kind = NEW.criterion_kind
        AND previous.project_revision < NEW.project_revision
        AND previous.authority_epoch <= NEW.authority_epoch
        AND NOT EXISTS (
          SELECT 1 FROM workflow_acceptance_criteria successor
          WHERE successor.supersedes_criterion_id = previous.criterion_id
        )
    ))
    BEGIN
      SELECT RAISE(ABORT, 'criterion must supersede the current head in the same scope');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_criterion_immutable_update
    BEFORE UPDATE ON workflow_acceptance_criteria
    BEGIN
      SELECT RAISE(ABORT, 'acceptance criteria are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_workflow_criterion_immutable_delete
    BEFORE DELETE ON workflow_acceptance_criteria
    BEGIN
      SELECT RAISE(ABORT, 'acceptance criteria are immutable');
    END;

    CREATE TABLE IF NOT EXISTS workflow_technical_verdicts (
      verdict_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      criterion_id TEXT NOT NULL,
      lifecycle_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      tested_source_revision TEXT NOT NULL CHECK (length(trim(tested_source_revision)) > 0),
      verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'fail', 'inconclusive')),
      policy_id TEXT NOT NULL CHECK (length(trim(policy_id)) > 0),
      policy_version TEXT NOT NULL CHECK (length(trim(policy_version)) > 0),
      rationale TEXT NOT NULL CHECK (length(trim(rationale)) > 0),
      supersedes_verdict_id TEXT DEFAULT NULL UNIQUE,
      created_at TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      project_revision INTEGER NOT NULL CHECK (project_revision > 0),
      authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
      UNIQUE (
        verdict_id, project_id, criterion_id, lifecycle_id, attempt_id,
        tested_source_revision, operation_id, project_revision, authority_epoch
      ),
      FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
      FOREIGN KEY (criterion_id, project_id, lifecycle_id)
        REFERENCES workflow_acceptance_criteria(criterion_id, project_id, lifecycle_id),
      FOREIGN KEY (attempt_id, lifecycle_id, project_id)
        REFERENCES workflow_execution_attempts(attempt_id, lifecycle_id, project_id),
      FOREIGN KEY (supersedes_verdict_id)
        REFERENCES workflow_technical_verdicts(verdict_id),
      FOREIGN KEY (operation_id, project_id, project_revision, authority_epoch)
        REFERENCES workflow_operations(
          operation_id, project_id, resulting_revision, resulting_authority_epoch
        )
    );

    CREATE TRIGGER IF NOT EXISTS trg_workflow_technical_verdict_scope
    BEFORE INSERT ON workflow_technical_verdicts
    WHEN NOT EXISTS (
      SELECT 1
      FROM workflow_acceptance_criteria criterion
      JOIN workflow_execution_attempts attempt ON attempt.attempt_id = NEW.attempt_id
      JOIN workflow_attempt_results result ON result.attempt_id = attempt.attempt_id
      WHERE criterion.criterion_id = NEW.criterion_id
        AND criterion.project_id = NEW.project_id
        AND criterion.lifecycle_id = NEW.lifecycle_id
        AND criterion.criterion_kind = 'technical'
        AND criterion.project_revision <= NEW.project_revision
        AND criterion.authority_epoch <= NEW.authority_epoch
        AND NOT EXISTS (
          SELECT 1 FROM workflow_acceptance_criteria successor
          WHERE successor.supersedes_criterion_id = criterion.criterion_id
        )
        AND attempt.project_id = NEW.project_id
        AND attempt.lifecycle_id = NEW.lifecycle_id
        AND attempt.attempt_state = 'settled'
        AND result.project_revision < NEW.project_revision
        AND result.authority_epoch <= NEW.authority_epoch
        AND (NEW.verdict != 'pass' OR result.outcome = 'succeeded')
    )
    BEGIN
      SELECT RAISE(ABORT, 'technical verdict requires the current criterion and matching settled attempt');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_technical_verdict_head
    BEFORE INSERT ON workflow_technical_verdicts
    WHEN (
      NEW.supersedes_verdict_id IS NULL AND EXISTS (
        SELECT 1 FROM workflow_technical_verdicts existing
        WHERE existing.project_id = NEW.project_id
          AND existing.criterion_id = NEW.criterion_id
          AND existing.lifecycle_id = NEW.lifecycle_id
          AND existing.attempt_id = NEW.attempt_id
          AND existing.tested_source_revision = NEW.tested_source_revision
      )
    ) OR (
      NEW.supersedes_verdict_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workflow_technical_verdicts previous
        WHERE previous.verdict_id = NEW.supersedes_verdict_id
          AND previous.project_id = NEW.project_id
          AND previous.criterion_id = NEW.criterion_id
          AND previous.lifecycle_id = NEW.lifecycle_id
          AND previous.attempt_id = NEW.attempt_id
          AND previous.tested_source_revision = NEW.tested_source_revision
          AND previous.project_revision < NEW.project_revision
          AND previous.authority_epoch <= NEW.authority_epoch
          AND NOT EXISTS (
            SELECT 1 FROM workflow_technical_verdicts successor
            WHERE successor.supersedes_verdict_id = previous.verdict_id
          )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'technical verdict must supersede the current head in the same scope');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_technical_verdict_immutable_update
    BEFORE UPDATE ON workflow_technical_verdicts
    BEGIN
      SELECT RAISE(ABORT, 'technical verdicts are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_workflow_technical_verdict_immutable_delete
    BEFORE DELETE ON workflow_technical_verdicts
    BEGIN
      SELECT RAISE(ABORT, 'technical verdicts are immutable');
    END;

    CREATE TABLE IF NOT EXISTS workflow_verification_evidence (
      evidence_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      verdict_id TEXT NOT NULL,
      criterion_id TEXT NOT NULL,
      lifecycle_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      evidence_class TEXT NOT NULL CHECK (
        evidence_class IN ('command', 'runtime', 'browser', 'artifact')
      ),
      command_or_tool TEXT NOT NULL CHECK (length(trim(command_or_tool)) > 0),
      working_directory TEXT NOT NULL CHECK (length(trim(working_directory)) > 0),
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      exit_code INTEGER DEFAULT NULL,
      observation TEXT NOT NULL CHECK (observation IN ('passed', 'failed', 'inconclusive')),
      source_revision TEXT NOT NULL CHECK (length(trim(source_revision)) > 0),
      observed_project_revision INTEGER NOT NULL CHECK (observed_project_revision > 0),
      content_hash TEXT NOT NULL CHECK (
        length(content_hash) = 71 AND
        substr(content_hash, 1, 7) = 'sha256:' AND
        content_hash = lower(content_hash) AND
        substr(content_hash, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      durable_output_ref TEXT NOT NULL CHECK (length(trim(durable_output_ref)) > 0),
      environment_json TEXT NOT NULL CHECK (
        length(trim(environment_json)) > 0 AND json_valid(environment_json) AND
        json_type(environment_json) = 'object' AND json(environment_json) != '{}'
      ),
      created_at TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      project_revision INTEGER NOT NULL CHECK (project_revision > 0),
      authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
      CHECK (
        julianday(started_at) IS NOT NULL AND
        julianday(ended_at) IS NOT NULL AND
        julianday(ended_at) >= julianday(started_at)
      ),
      FOREIGN KEY (
        verdict_id, project_id, criterion_id, lifecycle_id, attempt_id,
        source_revision, operation_id, project_revision, authority_epoch
      ) REFERENCES workflow_technical_verdicts(
        verdict_id, project_id, criterion_id, lifecycle_id, attempt_id,
        tested_source_revision, operation_id, project_revision, authority_epoch
      ),
      FOREIGN KEY (operation_id, project_id, project_revision, authority_epoch)
        REFERENCES workflow_operations(
          operation_id, project_id, resulting_revision, resulting_authority_epoch
        )
    );

    CREATE TRIGGER IF NOT EXISTS trg_workflow_evidence_verdict
    BEFORE INSERT ON workflow_verification_evidence
    WHEN NOT EXISTS (
      SELECT 1
      FROM workflow_technical_verdicts verdict
      JOIN workflow_acceptance_criteria criterion
        ON criterion.criterion_id = verdict.criterion_id
      JOIN workflow_execution_attempts attempt
        ON attempt.attempt_id = verdict.attempt_id
      WHERE verdict.verdict_id = NEW.verdict_id
        AND verdict.project_id = NEW.project_id
        AND verdict.criterion_id = NEW.criterion_id
        AND verdict.lifecycle_id = NEW.lifecycle_id
        AND verdict.attempt_id = NEW.attempt_id
        AND verdict.tested_source_revision = NEW.source_revision
        AND verdict.operation_id = NEW.operation_id
        AND verdict.project_revision = NEW.project_revision
        AND verdict.authority_epoch = NEW.authority_epoch
        AND criterion.evidence_class = NEW.evidence_class
        AND NEW.observed_project_revision >= COALESCE(attempt.settle_project_revision, attempt.claim_project_revision)
        AND NEW.observed_project_revision >= criterion.project_revision
        AND NEW.observed_project_revision < NEW.project_revision
        AND (
          (verdict.verdict = 'pass' AND NEW.observation = 'passed') OR
          (verdict.verdict = 'fail') OR
          (verdict.verdict = 'inconclusive' AND NEW.observation IN ('passed', 'inconclusive'))
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'verification evidence must match its verdict scope and operation');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_evidence_immutable_update
    BEFORE UPDATE ON workflow_verification_evidence
    BEGIN
      SELECT RAISE(ABORT, 'verification evidence is immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_workflow_evidence_immutable_delete
    BEFORE DELETE ON workflow_verification_evidence
    BEGIN
      SELECT RAISE(ABORT, 'verification evidence is immutable');
    END;

    CREATE TABLE IF NOT EXISTS workflow_human_acceptances (
      human_acceptance_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      criterion_id TEXT NOT NULL,
      lifecycle_id TEXT NOT NULL,
      answer_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      interaction_id TEXT NOT NULL,
      disposition TEXT NOT NULL CHECK (disposition IN ('accepted', 'rejected')),
      actor_id TEXT NOT NULL CHECK (length(trim(actor_id)) > 0),
      rationale TEXT NOT NULL CHECK (length(trim(rationale)) > 0),
      supersedes_human_acceptance_id TEXT DEFAULT NULL UNIQUE,
      created_at TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      project_revision INTEGER NOT NULL CHECK (project_revision > 0),
      authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
      UNIQUE (human_acceptance_id, project_id, criterion_id, lifecycle_id),
      FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
      FOREIGN KEY (criterion_id, project_id, lifecycle_id)
        REFERENCES workflow_acceptance_criteria(criterion_id, project_id, lifecycle_id),
      FOREIGN KEY (answer_id, question_id, interaction_id, project_id)
        REFERENCES workflow_answers(answer_id, question_id, interaction_id, project_id),
      FOREIGN KEY (supersedes_human_acceptance_id)
        REFERENCES workflow_human_acceptances(human_acceptance_id),
      FOREIGN KEY (operation_id, project_id, project_revision, authority_epoch)
        REFERENCES workflow_operations(
          operation_id, project_id, resulting_revision, resulting_authority_epoch
        )
    );

    CREATE TRIGGER IF NOT EXISTS trg_workflow_human_acceptance_scope
    BEFORE INSERT ON workflow_human_acceptances
    WHEN NOT EXISTS (
      SELECT 1
      FROM workflow_acceptance_criteria criterion
      JOIN workflow_answers answer ON answer.answer_id = NEW.answer_id
      JOIN workflow_open_questions question ON question.question_id = NEW.question_id
      JOIN workflow_interactions interaction ON interaction.interaction_id = NEW.interaction_id
      JOIN workflow_operations operation ON operation.operation_id = NEW.operation_id
      WHERE criterion.criterion_id = NEW.criterion_id
        AND criterion.project_id = NEW.project_id
        AND criterion.lifecycle_id = NEW.lifecycle_id
        AND criterion.criterion_kind = 'subjective_uat'
        AND criterion.project_revision <= NEW.project_revision
        AND criterion.authority_epoch <= NEW.authority_epoch
        AND NOT EXISTS (
          SELECT 1 FROM workflow_acceptance_criteria successor
          WHERE successor.supersedes_criterion_id = criterion.criterion_id
        )
        AND answer.project_id = NEW.project_id
        AND answer.question_id = NEW.question_id
        AND answer.interaction_id = NEW.interaction_id
        AND answer.answer_disposition = 'accepted'
        AND answer.operation_id = NEW.operation_id
        AND answer.project_revision = NEW.project_revision
        AND answer.authority_epoch = NEW.authority_epoch
        AND question.project_id = NEW.project_id
        AND question.lifecycle_id = NEW.lifecycle_id
        AND question.question_status = 'answered'
        AND question.accepted_answer_id = NEW.answer_id
        AND interaction.project_id = NEW.project_id
        AND interaction.question_id = NEW.question_id
        AND interaction.interaction_kind = 'subjective-uat'
        AND operation.project_id = NEW.project_id
        AND operation.actor_type = 'user'
        AND operation.actor_id = NEW.actor_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'human acceptance requires the current accepted subjective-UAT answer');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_human_acceptance_head
    BEFORE INSERT ON workflow_human_acceptances
    WHEN EXISTS (
      SELECT 1 FROM workflow_answers answer
      WHERE answer.answer_id = NEW.answer_id
    ) AND ((
      NEW.supersedes_human_acceptance_id IS NULL AND EXISTS (
        SELECT 1 FROM workflow_human_acceptances existing
        WHERE existing.project_id = NEW.project_id
          AND existing.criterion_id = NEW.criterion_id
      )
    ) OR (
      NEW.supersedes_human_acceptance_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workflow_human_acceptances previous
        WHERE previous.human_acceptance_id = NEW.supersedes_human_acceptance_id
          AND previous.project_id = NEW.project_id
          AND previous.criterion_id = NEW.criterion_id
          AND previous.lifecycle_id = NEW.lifecycle_id
          AND previous.project_revision < NEW.project_revision
          AND previous.authority_epoch <= NEW.authority_epoch
          AND NOT EXISTS (
            SELECT 1 FROM workflow_human_acceptances successor
            WHERE successor.supersedes_human_acceptance_id = previous.human_acceptance_id
          )
      )
    ))
    BEGIN
      SELECT RAISE(ABORT, 'human acceptance must supersede the current head');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_human_acceptance_immutable_update
    BEFORE UPDATE ON workflow_human_acceptances
    BEGIN
      SELECT RAISE(ABORT, 'human acceptances are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_workflow_human_acceptance_immutable_delete
    BEFORE DELETE ON workflow_human_acceptances
    BEGIN
      SELECT RAISE(ABORT, 'human acceptances are immutable');
    END;

    CREATE TABLE IF NOT EXISTS workflow_remediation_links (
      remediation_link_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_lifecycle_id TEXT NOT NULL,
      technical_verdict_id TEXT DEFAULT NULL,
      human_acceptance_id TEXT DEFAULT NULL,
      route_kind TEXT NOT NULL CHECK (route_kind IN ('rework', 'remediation')),
      remediation_fingerprint TEXT NOT NULL CHECK (
        length(trim(remediation_fingerprint)) > 0 AND
        remediation_fingerprint = lower(trim(remediation_fingerprint))
      ),
      required_outcome TEXT NOT NULL CHECK (length(trim(required_outcome)) > 0),
      target_lifecycle_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      project_revision INTEGER NOT NULL CHECK (project_revision > 0),
      authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
      CHECK ((technical_verdict_id IS NULL) != (human_acceptance_id IS NULL)),
      CHECK (
        (route_kind = 'rework' AND target_lifecycle_id = source_lifecycle_id) OR
        (route_kind = 'remediation' AND target_lifecycle_id != source_lifecycle_id)
      ),
      FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
      FOREIGN KEY (source_lifecycle_id, project_id)
        REFERENCES workflow_item_lifecycles(lifecycle_id, project_id),
      FOREIGN KEY (target_lifecycle_id, project_id)
        REFERENCES workflow_item_lifecycles(lifecycle_id, project_id),
      FOREIGN KEY (technical_verdict_id) REFERENCES workflow_technical_verdicts(verdict_id),
      FOREIGN KEY (human_acceptance_id) REFERENCES workflow_human_acceptances(human_acceptance_id),
      FOREIGN KEY (operation_id, project_id, project_revision, authority_epoch)
        REFERENCES workflow_operations(
          operation_id, project_id, resulting_revision, resulting_authority_epoch
        )
    );

    CREATE TRIGGER IF NOT EXISTS trg_workflow_remediation_source
    BEFORE INSERT ON workflow_remediation_links
    WHEN ((NEW.technical_verdict_id IS NULL) != (NEW.human_acceptance_id IS NULL)) AND ((
      NEW.technical_verdict_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workflow_technical_verdicts verdict
        JOIN workflow_acceptance_criteria criterion
          ON criterion.criterion_id = verdict.criterion_id
        WHERE verdict.verdict_id = NEW.technical_verdict_id
          AND verdict.project_id = NEW.project_id
          AND verdict.lifecycle_id = NEW.source_lifecycle_id
          AND verdict.verdict IN ('fail', 'inconclusive')
          AND EXISTS (
            SELECT 1 FROM workflow_verification_evidence evidence
            WHERE evidence.verdict_id = verdict.verdict_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM workflow_acceptance_criteria successor
            WHERE successor.supersedes_criterion_id = criterion.criterion_id
          )
          AND verdict.project_revision <= NEW.project_revision
          AND verdict.authority_epoch <= NEW.authority_epoch
      )
    ) OR (
      NEW.human_acceptance_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM workflow_human_acceptances acceptance
        JOIN workflow_acceptance_criteria criterion
          ON criterion.criterion_id = acceptance.criterion_id
        WHERE acceptance.human_acceptance_id = NEW.human_acceptance_id
          AND acceptance.project_id = NEW.project_id
          AND acceptance.lifecycle_id = NEW.source_lifecycle_id
          AND acceptance.disposition = 'rejected'
          AND NOT EXISTS (
            SELECT 1 FROM workflow_human_acceptances successor
            WHERE successor.supersedes_human_acceptance_id = acceptance.human_acceptance_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM workflow_acceptance_criteria successor
            WHERE successor.supersedes_criterion_id = criterion.criterion_id
          )
          AND acceptance.project_revision <= NEW.project_revision
          AND acceptance.authority_epoch <= NEW.authority_epoch
      )
    ))
    BEGIN
      SELECT RAISE(ABORT, 'remediation must route one failed verdict or rejected acceptance');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_workflow_remediation_target
    BEFORE INSERT ON workflow_remediation_links
    WHEN NEW.route_kind = 'remediation' AND NOT EXISTS (
      SELECT 1 FROM workflow_item_lifecycles target
      WHERE target.lifecycle_id = NEW.target_lifecycle_id
        AND target.project_id = NEW.project_id
        AND target.item_kind = 'task'
        AND target.lifecycle_status NOT IN ('completed', 'cancelled')
    )
    BEGIN
      SELECT RAISE(ABORT, 'remediation must target actionable task work');
    END;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_remediation_technical_target
    ON workflow_remediation_links(
      technical_verdict_id, target_lifecycle_id, remediation_fingerprint
    ) WHERE technical_verdict_id IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_remediation_human_target
    ON workflow_remediation_links(
      human_acceptance_id, target_lifecycle_id, remediation_fingerprint
    ) WHERE human_acceptance_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_workflow_failure_fingerprint
    ON workflow_failure_observations(lifecycle_id, failure_fingerprint, project_revision);

    CREATE INDEX IF NOT EXISTS idx_workflow_recovery_actions_budget
    ON workflow_recovery_actions(recovery_budget_id, project_revision);

    CREATE INDEX IF NOT EXISTS idx_workflow_evidence_verdict
    ON workflow_verification_evidence(verdict_id, evidence_id);

    CREATE TRIGGER IF NOT EXISTS trg_workflow_remediation_immutable_update
    BEFORE UPDATE ON workflow_remediation_links
    BEGIN
      SELECT RAISE(ABORT, 'remediation links are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_workflow_remediation_immutable_delete
    BEFORE DELETE ON workflow_remediation_links
    BEGIN
      SELECT RAISE(ABORT, 'remediation links are immutable durable history');
    END;
  `);
}
